import moment from 'moment';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import { syncEvent } from '../services/syncService.js';

/**
 * 💰 Receber pagamento de sessão específica (modo per-session)
 * Chamada manual quando o paciente paga no dia da consulta
 * POST /api/packages/sessions/:sessionId/pay
 */
export const receiveSessionPayment = async (req, res) => {
    const mongoSession = await mongoose.startSession();
    let transactionCommitted = false;

    try {
        await mongoSession.startTransaction();

        const { sessionId } = req.params;
        const { amount, method = 'pix', notes } = req.body;

        // 1. Buscar sessão
        const sessionDoc = await Session.findById(sessionId)
            .populate('package')
            .session(mongoSession);

        if (!sessionDoc) {
            return res.status(404).json({ success: false, message: 'Sessão não encontrada' });
        }

        // 2. Validar: sessão deve estar concluída
        if (sessionDoc.status !== 'completed') {
            return res.status(400).json({ 
                success: false, 
                message: 'Só é possível receber pagamento de sessões concluídas' 
            });
        }

        // 3. Verifica se já foi paga
        if (sessionDoc.isPaid) {
            return res.status(400).json({ 
                success: false, 
                message: 'Esta sessão já está paga' 
            });
        }

        // 4. Definir valor
        const packageDoc = sessionDoc.package;
        const paymentAmount = Number(amount) || sessionDoc.sessionValue || packageDoc?.sessionValue || 0;

        if (!paymentAmount || paymentAmount <= 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Valor de pagamento inválido' 
            });
        }

        // 5. Criar pagamento
        const paymentData = {
            package: packageDoc?._id || null,
            patient: sessionDoc.patient,
            doctor: sessionDoc.doctor,
            session: sessionDoc._id,
            amount: paymentAmount,
            paymentMethod: method,
            status: 'paid',
            kind: 'session_payment',
            serviceType: 'package_session',
            paymentDate: new Date(),
            notes: notes || `Pagamento sessão ${moment(sessionDoc.date).format('DD/MM/YYYY')} ${sessionDoc.time}`
        };

        const [paymentDoc] = await Payment.create([paymentData], { session: mongoSession });

        // 6. Atualizar sessão
        sessionDoc.isPaid = true;
        sessionDoc.paymentStatus = 'paid';
        sessionDoc.paymentId = paymentDoc._id;
        sessionDoc.visualFlag = 'ok';
        await sessionDoc.save({ session: mongoSession });

        // 6.1 Atualizar Appointment vinculado (sincroniza triade)
        if (sessionDoc.appointmentId) {
            await Appointment.findByIdAndUpdate(
                sessionDoc.appointmentId,
                {
                    paymentStatus: 'paid',
                    visualFlag: 'ok',
                    $push: {
                        history: {
                            action: 'payment_received',
                            timestamp: new Date(),
                            details: {
                                paymentId: paymentDoc._id,
                                amount: paymentAmount,
                                method: method
                            }
                        }
                    }
                },
                { session: mongoSession }
            );
        }

        // 7. Atualizar pacote (se tiver)
        if (packageDoc) {
            const currentTotalPaid = packageDoc.totalPaid || 0;
            const newTotalPaid = currentTotalPaid + paymentAmount;
            const newBalance = (packageDoc.totalValue || 0) - newTotalPaid;
            
            const newFinancialStatus = newBalance <= 0 ? 'paid' : 
                                      newTotalPaid > 0 ? 'partially_paid' : 'unpaid';

            await Package.findByIdAndUpdate(
                packageDoc._id,
                {
                    $inc: { totalPaid: paymentAmount },
                    $push: { payments: paymentDoc._id },
                    $set: {
                        balance: newBalance,
                        financialStatus: newFinancialStatus,
                        lastPaymentAt: new Date()
                    }
                },
                { session: mongoSession }
            );
        }

        // 8. Commit
        await mongoSession.commitTransaction();
        transactionCommitted = true;

        // 8.1 Sincronizar com MedicalEvent (auditoria)
        try {
            // Recarrega sessão completa para sincronizar
            const sessionToSync = await Session.findById(sessionId)
                .populate('package', 'sessionValue')
                .populate('appointmentId')
                .lean();
            
            // Sincroniza sessão com status atualizado
            await syncEvent(sessionToSync, 'session');
            
            // Cria registro de pagamento no MedicalEvent manualmente
            // (syncEvent ignora tipo 'payment', então criamos direto)
            const MedicalEvent = (await import('../models/MedicalEvent.js')).default;
            await MedicalEvent.findOneAndUpdate(
                { originalId: paymentDoc._id.toString(), type: 'payment' },
                {
                    originalId: paymentDoc._id.toString(),
                    type: 'payment',
                    date: new Date(),
                    patient: sessionDoc.patient?.toString(),
                    doctor: sessionDoc.doctor?.toString(),
                    value: paymentAmount,
                    operationalStatus: 'paid',
                    clinicalStatus: 'paid',
                    specialty: sessionDoc.specialty || sessionDoc.sessionType,
                    relatedSession: sessionId.toString(),
                    relatedPackage: packageDoc?._id?.toString(),
                    metadata: {
                        paymentMethod: method,
                        notes: notes,
                        receivedAt: new Date()
                    }
                },
                { upsert: true, new: true }
            );
        } catch (syncError) {
            console.warn('⚠️ Erro ao sincronizar com MedicalEvent:', syncError.message);
            // Não quebra o fluxo se falhar sync
        }

        // 9. Retornar
        const updatedSession = await Session.findById(sessionId)
            .populate('package', 'totalPaid balance financialStatus')
            .populate('patient', 'name')
            .populate('doctor', 'fullName')
            .lean();

        res.json({
            success: true,
            message: 'Pagamento recebido com sucesso',
            payment: paymentDoc,
            session: updatedSession
        });

    } catch (error) {
        if (!transactionCommitted && mongoSession.inTransaction()) {
            await mongoSession.abortTransaction();
        }
        
        console.error('❌ Erro ao receber pagamento da sessão:', error);
        
        res.status(500).json({
            success: false,
            message: error.message || 'Erro ao processar pagamento'
        });
    } finally {
        await mongoSession.endSession();
    }
};

/**
 * 📋 Listar sessões pendentes de pagamento
 * GET /api/packages/sessions/pending-payments
 */
export const listPendingPayments = async (req, res) => {
    try {
        const { patientId, doctorId, startDate, endDate } = req.query;
        
        const filters = {
            status: 'completed',
            isPaid: false
        };

        if (patientId) filters.patient = patientId;
        if (doctorId) filters.doctor = doctorId;
        if (startDate || endDate) {
            filters.date = {};
            if (startDate) filters.date.$gte = startDate;
            if (endDate) filters.date.$lte = endDate;
        }

        const sessions = await Session.find(filters)
            .populate('patient', 'name')
            .populate('doctor', 'fullName')
            .populate('package', 'sessionValue')
            .sort({ date: -1 })
            .lean();

        const totalPending = sessions.reduce((sum, s) => {
            return sum + (s.sessionValue || s.package?.sessionValue || 0);
        }, 0);

        res.json({
            success: true,
            sessions,
            count: sessions.length,
            totalPending
        });

    } catch (error) {
        console.error('❌ Erro ao listar pagamentos pendentes:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};
