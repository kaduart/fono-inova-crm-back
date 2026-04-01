// back/routes/Payment.payment-multi.OPTIMIZED.js
/**
 * POST /api/payments/balance/:patientId/payment-multi
 * 
 * VERSÃO OTIMIZADA - Correções de performance:
 * 1. Remove populate pesado da transaction
 * 2. Simplifica lógica de marcar débitos
 * 3. Paralelização máxima dos updates
 * 4. Transaction SÓ para operações críticas de saldo
 */

import express from 'express';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// POST /api/payments/balance/:patientId/payment-multi
router.post('/balance/:patientId/payment-multi', auth, async (req, res) => {
    const { patientId } = req.params;
    const { payments, debitIds, totalAmount } = req.body;
    
    // ⏱️ Timing para debug de performance
    const startTime = Date.now();
    const timings = {};

    try {
        // ============================================
        // 1. VALIDAÇÃO RÁPIDA (fora de transaction)
        // ============================================
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ 
                success: false, 
                message: 'ID de paciente inválido' 
            });
        }

        if (!payments || !Array.isArray(payments) || payments.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Dados de pagamento inválidos' 
            });
        }

        const totalPaymentAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        
        if (totalPaymentAmount <= 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Valor do pagamento deve ser maior que zero' 
            });
        }

        // ============================================
        // 2. BUSCA BALANCE SEM POPULATE (rápido)
        // ============================================
        const balanceQueryStart = Date.now();
        
        // 🔥 NÃO faz populate aqui - só pega o documento cru
        let balance = await PatientBalance.findOne({ patient: patientId }).lean();
        
        timings.balanceQuery = Date.now() - balanceQueryStart;

        // ✅ CORREÇÃO ORDEM LÓGICA: Verifica existência ANTES de verificar débitos
        if (!balance) {
            return res.status(404).json({ 
                success: false, 
                message: 'Saldo do paciente não encontrado' 
            });
        }

        // Verifica débitos pendentes
        const pendingDebits = balance.transactions.filter(t => 
            t.type === 'debit' && !t.isPaid
        );

        if (pendingDebits.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Não há débitos pendentes para pagar' 
            });
        }

        // Valida se os débitos selecionados existem
        const validDebitIds = debitIds?.filter(id => 
            pendingDebits.some(d => d._id.toString() === id)
        ) || [];

        if (validDebitIds.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Nenhum débito válido selecionado' 
            });
        }

        // ============================================
        // 3. PREPARA DADOS (fora de transaction)
        // ============================================
        const prepareStart = Date.now();
        
        const now = new Date();
        const today = moment().tz("America/Sao_Paulo").format("YYYY-MM-DD");
        
        // Coleta IDs das sessões/appointments a serem pagos
        const paidSessionIds = [];
        const paidAppointmentIds = [];
        
        validDebitIds.forEach(debitId => {
            const debit = pendingDebits.find(d => d._id.toString() === debitId);
            if (debit) {
                if (debit.sessionId) paidSessionIds.push(debit.sessionId.toString());
                if (debit.appointmentId) paidAppointmentIds.push(debit.appointmentId.toString());
            }
        });

        // Prepara dados do pagamento
        const paymentMethodsList = payments
            .filter(p => p.amount > 0)
            .map(p => p.paymentMethod || 'dinheiro')
            .join(' + ');

        const transactionData = {
            _id: new mongoose.Types.ObjectId(), // Gera ID aqui para usar depois
            type: 'payment',
            amount: totalPaymentAmount,
            description: `Pagamento de ${validDebitIds.length} débito(s) - ${paymentMethodsList}`,
            paymentMethod: payments[0]?.paymentMethod || 'dinheiro',
            registeredBy: req.user?._id,
            sessionId: null,
            appointmentId: null,
            transactionDate: now,
            createdAt: now
        };

        timings.prepare = Date.now() - prepareStart;

        // ============================================
        // 4. TRANSACTION MÍNIMA (só saldo)
        // ============================================
        const txStart = Date.now();
        
        const mongoSession = await mongoose.startSession();
        let transactionCommitted = false;

        try {
            await mongoSession.startTransaction();

            // 🔥 UPDATE ATÔMICO - sem populate, sem loops complexos
            const updateResult = await PatientBalance.findOneAndUpdate(
                { 
                    patient: patientId,
                    'transactions._id': { $in: validDebitIds.map(id => new mongoose.Types.ObjectId(id)) }
                },
                {
                    $set: {
                        'transactions.$[debit].isPaid': true,
                        'transactions.$[debit].paidAmount': '$transactions.$[debit].amount',
                        'transactions.$[debit].paidAt': now,
                        lastTransactionAt: now
                    },
                    $inc: {
                        currentBalance: -totalPaymentAmount,
                        totalCredited: totalPaymentAmount
                    },
                    $push: {
                        transactions: transactionData
                    }
                },
                {
                    session: mongoSession,
                    arrayFilters: [{ 'debit._id': { $in: validDebitIds.map(id => new mongoose.Types.ObjectId(id)) }, 'debit.type': 'debit' }],
                    new: true
                }
            );

            if (!updateResult) {
                await mongoSession.abortTransaction();
                return res.status(500).json({
                    success: false,
                    message: 'Erro ao atualizar saldo - débitos não encontrados'
                });
            }

            await mongoSession.commitTransaction();
            transactionCommitted = true;
            
            timings.transaction = Date.now() - txStart;

        } catch (txError) {
            if (mongoSession.inTransaction()) {
                await mongoSession.abortTransaction();
            }
            throw txError;
        } finally {
            await mongoSession.endSession();
        }

        // ============================================
        // 5. UPDATES PARALELOS (fora da transaction)
        // ============================================
        const parallelStart = Date.now();
        
        // 🔥 Paralelização máxima - todos os updates ao mesmo tempo
        const updatePromises = [];

        // Atualiza Sessions
        if (paidSessionIds.length > 0) {
            updatePromises.push(
                Session.updateMany(
                    { _id: { $in: paidSessionIds } },
                    {
                        $set: {
                            isPaid: true,
                            paymentStatus: 'paid',
                            visualFlag: 'ok',
                            paidAt: now,
                            updatedAt: now
                        }
                    }
                )
            );
        }

        // Atualiza Appointments
        if (paidAppointmentIds.length > 0) {
            updatePromises.push(
                Appointment.updateMany(
                    { _id: { $in: paidAppointmentIds } },
                    {
                        $set: {
                            paymentStatus: 'paid',
                            visualFlag: 'ok',
                            paidAt: now,
                            updatedAt: now
                        },
                        $push: {
                            history: {
                                $each: paidAppointmentIds.map(() => ({
                                    action: 'payment_received',
                                    newStatus: 'paid',
                                    changedBy: req.user?._id,
                                    timestamp: now,
                                    context: 'financial'
                                }))
                            }
                        }
                    }
                )
            );

            // Atualiza Payments vinculados aos appointments
            updatePromises.push(
                Payment.updateMany(
                    { appointment: { $in: paidAppointmentIds } },
                    {
                        $set: {
                            status: 'paid',
                            paymentDate: today,
                            paidAt: now,
                            paymentMethod: payments[0]?.paymentMethod || 'dinheiro',
                            updatedAt: now
                        }
                    }
                )
            );
        }

        // Executa todos em paralelo
        const parallelResults = await Promise.allSettled(updatePromises);
        
        // Log de falhas (não falha a operação principal)
        const failures = parallelResults.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
            console.warn('⚠️  Alguns updates paralelos falharam:', failures.map(f => f.reason?.message));
        }

        timings.parallel = Date.now() - parallelStart;

        // ============================================
        // 6. RESPOSTA
        // ============================================
        const totalTime = Date.now() - startTime;
        
        res.json({
            success: true,
            message: `Pagamento de ${validDebitIds.length} débito(s) registrado`,
            data: {
                currentBalance: balance.currentBalance - totalPaymentAmount,
                payment: transactionData,
                totalPaid: totalPaymentAmount,
                debitsPaid: validDebitIds.length,
                sessionsUpdated: paidSessionIds.length,
                appointmentsUpdated: paidAppointmentIds.length
            },
            // 🚀 Timings para monitoramento de performance
            performance: {
                totalMs: totalTime,
                balanceQueryMs: timings.balanceQuery,
                prepareMs: timings.prepare,
                transactionMs: timings.transaction,
                parallelUpdatesMs: timings.parallel
            }
        });

        // Log se demorou muito
        if (totalTime > 3000) {
            console.warn(`⚠️  payment-multi demorou ${totalTime}ms:`, timings);
        }

    } catch (error) {
        console.error('❌ Erro ao registrar pagamentos múltiplos:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro ao registrar pagamentos: ' + error.message 
        });
    }
});

export default router;
