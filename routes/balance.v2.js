// routes/balance.v2.js
/**
 * Rotas V2 para Balance - Event-driven
 * 
 * GET  /v2/balance/:patientId           → Lista saldo e transações
 * POST /v2/balance/:patientId/debit     → Adiciona débito (event)
 * POST /v2/balance/:patientId/payment   → Adiciona pagamento (event)
 * POST /v2/balance/:patientId/payment-multi → Múltiplos pagamentos (event)
 * PATCH /v2/balance/:patientId/transaction/:id → Edita transação (event)
 * DELETE /v2/balance/:patientId/transaction/:id → Remove transação (event)
 * GET /v2/balance/debtors               → Lista devedores
 */

import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import PatientBalance from '../models/PatientBalance.js';

const router = express.Router();

// ======================================================
// GET /v2/balance/:patientId - Lista saldo e transações
// ======================================================
router.get('/:patientId', auth, async (req, res) => {
    try {
        const { patientId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({
                success: false,
                error: 'ID de paciente inválido'
            });
        }

        let balance = await PatientBalance.findOne({ patient: patientId })
            .populate('transactions.registeredBy', 'fullName')
            .lean();

        if (!balance) {
            return res.json({
                success: true,
                data: {
                    patientId,
                    currentBalance: 0,
                    totalDebited: 0,
                    totalCredited: 0,
                    transactions: []
                }
            });
        }

        res.json({
            success: true,
            data: {
                patientId,
                currentBalance: balance.currentBalance,
                totalDebited: balance.totalDebited || 0,
                totalCredited: balance.totalCredited || 0,
                transactions: balance.transactions || []
            }
        });

    } catch (error) {
        console.error('[BalanceV2] Erro ao buscar saldo:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar saldo: ' + error.message
        });
    }
});

// ======================================================
// POST /v2/balance/:patientId/debit - Adiciona débito (event-driven)
// ======================================================
router.post('/:patientId/debit', auth, async (req, res) => {
    try {
        const { patientId } = req.params;
        const { amount, description, sessionId, appointmentId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ success: false, error: 'ID de paciente inválido' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Valor deve ser maior que zero' });
        }

        const correlationId = `balance_debit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const eventResult = await publishEvent(
            EventTypes.BALANCE_DEBIT_REQUESTED,
            {
                patientId,
                amount,
                description,
                sessionId,
                appointmentId,
                type: 'debit',
                requestedBy: req.user?._id?.toString(),
                requestedAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'balance',
                aggregateId: patientId,
                metadata: {
                    source: 'balance_api_v2',
                    userId: req.user?._id?.toString()
                }
            }
        );

        res.status(202).json({
            success: true,
            message: 'Débito enfileirado para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                patientId,
                amount,
                status: 'pending'
            }
        });

    } catch (error) {
        console.error('[BalanceV2] Erro ao criar débito:', error);
        res.status(500).json({ success: false, error: 'Erro ao criar débito: ' + error.message });
    }
});

// ======================================================
// POST /v2/balance/:patientId/payment - Adiciona pagamento (event-driven)
// ======================================================
router.post('/:patientId/payment', auth, async (req, res) => {
    try {
        const { patientId } = req.params;
        const { amount, paymentMethod, description, sessionId, appointmentId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ success: false, error: 'ID de paciente inválido' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Valor deve ser maior que zero' });
        }

        const correlationId = `balance_payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const eventResult = await publishEvent(
            EventTypes.PAYMENT_REQUESTED,
            {
                patientId,
                amount,
                paymentMethod: paymentMethod || 'cash',
                description,
                sessionId,
                appointmentId,
                type: 'balance_payment',
                requestedBy: req.user?._id?.toString(),
                requestedAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'payment',
                aggregateId: patientId,
                metadata: {
                    source: 'balance_api_v2',
                    userId: req.user?._id?.toString()
                }
            }
        );

        res.status(202).json({
            success: true,
            message: 'Pagamento enfileirado para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                status: 'pending'
            }
        });

    } catch (error) {
        console.error('[BalanceV2] Erro ao criar pagamento:', error);
        res.status(500).json({ success: false, error: 'Erro ao criar pagamento: ' + error.message });
    }
});

// ======================================================
// POST /v2/balance/:patientId/payment-multi - Múltiplos pagamentos
// ======================================================
router.post('/:patientId/payment-multi', auth, async (req, res) => {
    try {
        const { patientId } = req.params;
        const { payments, debitIds, totalAmount } = req.body;

        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ success: false, error: 'ID de paciente inválido' });
        }

        if (!payments?.length || !debitIds?.length || totalAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Dados de pagamento inválidos' });
        }

        const correlationId = `balance_multi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const eventResult = await publishEvent(
            EventTypes.PAYMENT_PROCESS_REQUESTED,
            {
                type: 'multi_payment',
                patientId,
                payments,
                debitIds,
                totalAmount,
                requestedBy: req.user?._id?.toString(),
                requestedAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'payment',
                aggregateId: patientId,
                priority: 7,
                metadata: {
                    source: 'balance_api_v2',
                    userId: req.user?._id?.toString()
                }
            }
        );

        res.status(202).json({
            success: true,
            message: `Pagamento de ${debitIds.length} débito(s) enfileirado`,
            data: {
                eventId: eventResult.eventId,
                correlationId,
                status: 'pending',
                totalAmount
            }
        });

    } catch (error) {
        console.error('[BalanceV2] Erro no payment-multi:', error);
        res.status(500).json({ success: false, error: 'Erro ao criar pagamento múltiplo: ' + error.message });
    }
});

// ======================================================
// PATCH /v2/balance/:patientId/transaction/:transactionId - Edita transação
// ======================================================
router.patch('/:patientId/transaction/:transactionId', auth, async (req, res) => {
    try {
        const { patientId, transactionId } = req.params;
        const { amount, description } = req.body;

        if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(transactionId)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const correlationId = `balance_update_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const eventResult = await publishEvent(
            EventTypes.BALANCE_UPDATE_REQUESTED,
            {
                patientId,
                transactionId,
                amount,
                description,
                updatedBy: req.user?._id?.toString(),
                updatedAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'balance',
                aggregateId: patientId
            }
        );

        res.status(202).json({
            success: true,
            message: 'Atualização enfileirada para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                status: 'pending'
            }
        });

    } catch (error) {
        console.error('[BalanceV2] Erro ao atualizar transação:', error);
        res.status(500).json({ success: false, error: 'Erro ao atualizar: ' + error.message });
    }
});

// ======================================================
// DELETE /v2/balance/:patientId/transaction/:transactionId - Remove transação (soft delete)
// ======================================================
router.delete('/:patientId/transaction/:transactionId', auth, async (req, res) => {
    try {
        const { patientId, transactionId } = req.params;
        const { reason } = req.body;

        if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(transactionId)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        if (!reason) {
            return res.status(400).json({ success: false, error: 'Motivo da exclusão é obrigatório' });
        }

        const correlationId = `balance_delete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const eventResult = await publishEvent(
            EventTypes.BALANCE_DELETE_REQUESTED,
            {
                patientId,
                transactionId,
                reason,
                deletedBy: req.user?._id?.toString(),
                deletedAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'balance',
                aggregateId: patientId
            }
        );

        res.status(202).json({
            success: true,
            message: 'Exclusão enfileirada para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                status: 'pending'
            }
        });

    } catch (error) {
        console.error('[BalanceV2] Erro ao deletar transação:', error);
        res.status(500).json({ success: false, error: 'Erro ao deletar: ' + error.message });
    }
});

// ======================================================
// GET /v2/balance/debtors - Lista devedores
// ======================================================
router.get('/debtors', auth, async (req, res) => {
    try {
        const debtors = await PatientBalance.find({ currentBalance: { $gt: 0 } })
            .populate('patient', 'fullName phoneNumber email')
            .sort({ currentBalance: -1 })
            .lean();

        res.json({
            success: true,
            data: debtors.map(d => ({
                patientId: d.patient?._id,
                patientName: d.patient?.fullName,
                phoneNumber: d.patient?.phoneNumber,
                email: d.patient?.email,
                currentBalance: d.currentBalance,
                totalDebited: d.totalDebited,
                totalCredited: d.totalCredited,
                lastTransactionAt: d.lastTransactionAt
            }))
        });

    } catch (error) {
        console.error('[BalanceV2] Erro ao buscar devedores:', error);
        res.status(500).json({ success: false, error: 'Erro ao buscar devedores: ' + error.message });
    }
});

export default router;
