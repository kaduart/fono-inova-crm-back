// back/routes/payment.v2.js
/**
 * ROTAS EVENT-DRIVEN DE PAGAMENTO
 * 
 * POST /api/v2/payments/request         → Inicia pagamento (async)
 * POST /api/v2/payments/webhook         → Confirmação externa (Sicoob, etc)
 * GET  /api/v2/payments/:id/status      → Consulta status
 * 
 * Fluxo:
 * 1. API recebe request
 * 2. Publica PAYMENT_REQUESTED → fila payment-processing
 * 3. paymentWorker processa (Saga Pattern)
 * 4. Retorna jobId imediatamente (não espera processamento)
 */

import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { getQueue } from '../infrastructure/queue/queueConfig.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import PatientBalance from '../models/PatientBalance.js';

const router = express.Router();

// ============================================
// POST /api/v2/payments/request
// Inicia pagamento de forma assíncrona
// ============================================
router.post('/request', auth, async (req, res) => {
    const {
        appointmentId,
        patientId,
        doctorId,
        amount,
        paymentMethod = 'pix',
        notes,
        // Para payment-multi (saldo/débitos)
        debitIds,
        payments,
        isMultiPayment = false
    } = req.body;

    try {
        // Validações básicas
        if (!patientId || !amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios: patientId, amount > 0'
            });
        }

        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({
                success: false,
                error: 'patientId inválido'
            });
        }

        // Gera correlationId único para rastrear todo o fluxo
        const correlationId = `payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Gera idempotencyKey (evita duplicidade se reenviar)
        const idempotencyKey = appointmentId 
            ? `payment_${appointmentId}_${amount}`
            : `payment_${patientId}_${amount}_${Date.now()}`;

        // 🎯 PUBLICA EVENTO: PAYMENT_REQUESTED
        const eventResult = await publishEvent(
            EventTypes.PAYMENT_REQUESTED,
            {
                appointmentId: appointmentId?.toString(),
                patientId: patientId.toString(),
                doctorId: doctorId?.toString(),
                amount,
                paymentMethod,
                notes,
                // Dados para payment-multi
                isMultiPayment,
                debitIds: debitIds?.map(id => id.toString()),
                payments,
                requestedBy: req.user?._id?.toString(),
                requestedAt: new Date().toISOString()
            },
            {
                correlationId,
                idempotencyKey,
                aggregateType: 'payment',
                aggregateId: appointmentId || patientId,
                metadata: {
                    source: 'payment_api_v2',
                    userId: req.user?._id?.toString(),
                    ip: req.ip,
                    userAgent: req.headers['user-agent']
                }
            }
        );

        console.log(`[PaymentV2] Evento publicado: ${eventResult.eventId}`, {
            correlationId,
            queue: eventResult.queue,
            jobId: eventResult.jobId,
            amount
        });

        // Retorna imediatamente (não espera processamento)
        res.status(202).json({
            success: true,
            message: 'Pagamento enfileirado para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                idempotencyKey,
                jobId: eventResult.jobId,
                status: 'pending',
                amount,
                paymentMethod,
                checkStatusUrl: `/api/v2/payments/status/${eventResult.eventId}`
            }
        });

    } catch (error) {
        console.error('[PaymentV2] Erro ao publicar evento:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao iniciar pagamento: ' + error.message
        });
    }
});

// ============================================
// POST /api/v2/payments/balance/:patientId/multi
// Payment-multi assíncrono (para saldo/débitos)
// ============================================
router.post('/balance/:patientId/multi', auth, async (req, res) => {
    const { patientId } = req.params;
    const { payments, debitIds, totalAmount } = req.body;

    try {
        // Validações
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({
                success: false,
                error: 'ID de paciente inválido'
            });
        }

        if (!payments?.length || !debitIds?.length || totalAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Dados de pagamento inválidos'
            });
        }

        // Verifica se há débitos pendentes (query rápida)
        const balance = await PatientBalance.findOne(
            { patient: patientId },
            { transactions: { $elemMatch: { type: 'debit', isPaid: false } } }
        ).lean();

        if (!balance?.transactions?.length) {
            return res.status(400).json({
                success: false,
                error: 'Não há débitos pendentes para este paciente'
            });
        }

        const correlationId = `payment_multi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const idempotencyKey = `payment_multi_${patientId}_${debitIds.sort().join('_')}`;

        // 🎯 PUBLICA EVENTO: PAYMENT_PROCESS_REQUESTED (tipo multi)
        const eventResult = await publishEvent(
            EventTypes.PAYMENT_PROCESS_REQUESTED,
            {
                type: 'multi_payment',
                patientId: patientId.toString(),
                payments,
                debitIds: debitIds.map(id => id.toString()),
                totalAmount,
                requestedBy: req.user?._id?.toString(),
                requestedAt: new Date().toISOString()
            },
            {
                correlationId,
                idempotencyKey,
                aggregateType: 'payment',
                aggregateId: patientId,
                priority: 7, // Prioridade alta para pagamentos
                metadata: {
                    source: 'payment_multi_api_v2',
                    userId: req.user?._id?.toString()
                }
            }
        );

        console.log(`[PaymentV2] Payment-multi enfileirado: ${eventResult.eventId}`, {
            correlationId,
            patientId,
            totalAmount,
            debitCount: debitIds.length
        });

        res.status(202).json({
            success: true,
            message: `Pagamento de ${debitIds.length} débito(s) enfileirado`,
            data: {
                eventId: eventResult.eventId,
                correlationId,
                jobId: eventResult.jobId,
                status: 'pending',
                totalAmount,
                debitsCount: debitIds.length,
                checkStatusUrl: `/api/v2/payments/status/${eventResult.eventId}`
            }
        });

    } catch (error) {
        console.error('[PaymentV2] Erro no payment-multi:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao iniciar pagamento múltiplo: ' + error.message
        });
    }
});

// ============================================
// GET /api/v2/payments/status/:eventId
// Consulta status do pagamento pelo eventId
// ============================================
router.get('/status/:eventId', auth, async (req, res) => {
    const { eventId } = req.params;

    try {
        // Busca no EventStore
        const EventStore = (await import('../models/EventStore.js')).default;
        const event = await EventStore.findOne({ eventId });

        if (!event) {
            return res.status(404).json({
                success: false,
                error: 'Evento não encontrado'
            });
        }

        // Busca pagamento relacionado
        let payment = null;
        if (event.payload?.appointmentId) {
            payment = await Payment.findOne({ 
                appointment: event.payload.appointmentId 
            }).select('status amount paymentMethod paidAt');
        }

        res.json({
            success: true,
            data: {
                eventId: event.eventId,
                eventType: event.eventType,
                status: event.status, // pending, processing, processed, failed
                aggregateId: event.aggregateId,
                correlationId: event.correlationId,
                createdAt: event.createdAt,
                processedAt: event.processedAt,
                error: event.error,
                payment: payment ? {
                    id: payment._id,
                    status: payment.status,
                    amount: payment.amount,
                    method: payment.paymentMethod,
                    paidAt: payment.paidAt
                } : null
            }
        });

    } catch (error) {
        console.error('[PaymentV2] Erro ao consultar status:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao consultar status: ' + error.message
        });
    }
});

// ============================================
// POST /api/v2/payments/webhook
// Webhook para confirmação externa (Sicoob, etc)
// ============================================
router.post('/webhook', async (req, res) => {
    const {
        paymentId,
        transactionId,
        status, // 'paid', 'failed', 'cancelled'
        gateway,
        metadata = {}
    } = req.body;

    try {
        // Validação básica
        if (!paymentId || !status) {
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios: paymentId, status'
            });
        }

        const correlationId = `webhook_${gateway}_${Date.now()}`;

        // Determina tipo de evento baseado no status
        const eventType = status === 'paid' 
            ? EventTypes.PAYMENT_COMPLETED 
            : EventTypes.PAYMENT_FAILED;

        // 🎯 PUBLICA EVENTO de confirmação
        const eventResult = await publishEvent(
            eventType,
            {
                paymentId: paymentId.toString(),
                transactionId,
                status,
                gateway,
                confirmedAt: new Date().toISOString(),
                metadata
            },
            {
                correlationId,
                aggregateType: 'payment',
                aggregateId: paymentId,
                metadata: {
                    source: 'payment_webhook',
                    gateway
                }
            }
        );

        console.log(`[PaymentV2] Webhook processado: ${paymentId}`, {
            status,
            gateway,
            eventId: eventResult.eventId
        });

        res.json({
            success: true,
            message: `Webhook ${status} processado`,
            data: {
                eventId: eventResult.eventId,
                correlationId
            }
        });

    } catch (error) {
        console.error('[PaymentV2] Erro no webhook:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao processar webhook: ' + error.message
        });
    }
});

// ============================================
// GET /api/v2/payments/queue/status
// Status da fila (para monitoramento)
// ============================================
router.get('/queue/status', auth, async (req, res) => {
    try {
        const queue = getQueue('payment-processing');
        const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount()
        ]);

        res.json({
            success: true,
            data: {
                queue: 'payment-processing',
                waiting,
                active,
                completed,
                failed,
                total: waiting + active
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erro ao consultar fila: ' + error.message
        });
    }
});

export default router;
