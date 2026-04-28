// back/routes/payment.v2.js
/**
 * ROTAS EVENT-DRIVEN DE PAGAMENTO - V2 BLINDADO
 * 
 * Regra de Ouro: Fail fast na API, não no worker
 * 
 * POST /api/v2/payments/request         → Inicia pagamento (async)
 * POST /api/v2/payments/webhook         → Confirmação externa (Sicoob, etc)
 * GET  /api/v2/payments/:id/status      → Consulta status
 * 
 * Fluxo:
 * 1. API recebe request → VALIDAÇÃO RIGOROSA (fail fast)
 * 2. Normaliza payload garantido (type sempre presente)
 * 3. Publica evento → fila payment-processing
 * 4. Worker processa (assume dados válidos)
 * 5. Retorna jobId imediatamente (não espera processamento)
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
// SCHEMA VALIDATION - Constantes
// ============================================
const VALID_PAYMENT_METHODS = ['dinheiro', 'pix', 'credit_card', 'debit_card', 'cartao', 'cartão', 'transferencia', 'transferência', 'cash', 'bank_transfer'];
const VALID_PAYMENT_TYPES = ['appointment_payment', 'multi_payment', 'balance_credit', 'standalone'];

// ============================================
// HELPER: Validação de ObjectId
// ============================================
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ============================================
// HELPER: Normalização de método de pagamento
// ============================================
const normalizePaymentMethod = (method) => {
    const methodMap = {
        'dinheiro': 'cash',
        'pix': 'pix',
        'credit_card': 'credit_card',
        'debit_card': 'debit_card',
        'cartao': 'credit_card',
        'cartão': 'credit_card',
        'transferencia': 'bank_transfer',
        'transferência': 'bank_transfer',
        'cash': 'cash',
        'bank_transfer': 'bank_transfer'
    };
    return methodMap[method] || 'cash';
};

// ============================================
// POST /api/v2/payments/request
// Inicia pagamento de forma assíncrona - BLINDADO
// ============================================
router.post('/request', auth, async (req, res) => {
    const {
        appointmentId,
        patientId,
        doctorId,
        amount,
        paymentMethod = 'pix',
        notes,
        type = 'appointment_payment', // 🎯 OBRIGATÓRIO: tipo do pagamento
        // Para payment-multi (saldo/débitos)
        debitIds,
        payments,
        isMultiPayment = false
    } = req.body;

    // ========================================
    // 🛡️ VALIDAÇÃO RIGOROSA - Fail Fast
    // ========================================
    
    // 1. type é obrigatório e deve ser válido
    if (!type || !VALID_PAYMENT_TYPES.includes(type)) {
        return res.status(400).json({
            success: false,
            error: `Campo 'type' obrigatório. Valores válidos: ${VALID_PAYMENT_TYPES.join(', ')}`,
            received: { type }
        });
    }

    // 2. patientId é sempre obrigatório
    if (!patientId) {
        return res.status(400).json({
            success: false,
            error: 'Campo obrigatório: patientId',
            code: 'MISSING_PATIENT_ID'
        });
    }

    if (!isValidObjectId(patientId)) {
        return res.status(400).json({
            success: false,
            error: 'patientId inválido',
            code: 'INVALID_PATIENT_ID',
            received: patientId
        });
    }

    // 3. amount é sempre obrigatório e deve ser válido
    if (!amount || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({
            success: false,
            error: 'Campo obrigatório: amount (número > 0)',
            code: 'INVALID_AMOUNT',
            received: { amount, type: typeof amount }
        });
    }

    // 4. Validação específica por tipo
    if (type === 'appointment_payment') {
        // appointment_payment REQUER appointmentId
        if (!appointmentId) {
            return res.status(400).json({
                success: false,
                error: 'Para type=appointment_payment, appointmentId é obrigatório',
                code: 'MISSING_APPOINTMENT_ID',
                hint: 'Crie um agendamento primeiro ou use type=standalone'
            });
        }
        
        if (!isValidObjectId(appointmentId)) {
            return res.status(400).json({
                success: false,
                error: 'appointmentId inválido',
                code: 'INVALID_APPOINTMENT_ID',
                received: appointmentId
            });
        }
    }

    // 5. Validação para multi_payment
    if (type === 'multi_payment' || isMultiPayment) {
        if (!debitIds?.length || !payments?.length) {
            return res.status(400).json({
                success: false,
                error: 'Para multi_payment, debitIds e payments são obrigatórios',
                code: 'MISSING_MULTI_PAYMENT_DATA'
            });
        }
    }

    // 6. Validação de método de pagamento
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
        return res.status(400).json({
            success: false,
            error: `Método de pagamento inválido. Valores válidos: ${VALID_PAYMENT_METHODS.join(', ')}`,
            code: 'INVALID_PAYMENT_METHOD',
            received: paymentMethod
        });
    }

    try {
        // ========================================
        // 🔍 VERIFICAÇÃO PRÉVIA: Appointment existe? (para appointment_payment)
        // ========================================
        if (type === 'appointment_payment' && appointmentId) {
            const appointmentExists = await Appointment.exists({ _id: appointmentId });
            if (!appointmentExists) {
                return res.status(404).json({
                    success: false,
                    error: 'Agendamento não encontrado',
                    code: 'APPOINTMENT_NOT_FOUND',
                    appointmentId
                });
            }
        }

        // ========================================
        // 🎯 GERA IDS DE RASTREABILIDADE
        // ========================================
        const correlationId = `payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // IdempotencyKey baseado no contexto (evita duplicatas)
        const idempotencyKey = type === 'appointment_payment' && appointmentId
            ? `payment_${appointmentId}_${amount}_${type}`
            : `payment_${patientId}_${amount}_${Date.now()}`;

        // ========================================
        // 🛡️ IDEMPOTÊNCIA: Verifica se já existe
        // ========================================
        const EventStore = (await import('../models/EventStore.js')).default;
        
        const existingEvent = await EventStore.findOne({ 
            idempotencyKey,
            status: { $in: ['pending', 'processing', 'processed'] }
        });
        
        if (existingEvent) {
            console.log(`[PaymentV2] Idempotência: request já existe`, {
                idempotencyKey,
                eventId: existingEvent.eventId,
                status: existingEvent.status
            });
            
            return res.status(200).json({
                success: true,
                message: 'Pagamento já foi enfileirado',
                duplicated: true,
                data: {
                    eventId: existingEvent.eventId,
                    correlationId: existingEvent.correlationId,
                    idempotencyKey,
                    status: existingEvent.status,
                    createdAt: existingEvent.createdAt,
                    checkStatusUrl: `/api/v2/payments/status/${existingEvent.eventId}`
                }
            });
        }

        // ========================================
        // 📦 NORMALIZAÇÃO FORÇADA DO PAYLOAD
        // ========================================
        // Worker NUNCA deve receber dados inconsistentes
        const normalizedPayload = {
            // Identificadores obrigatórios
            type,                           // 🎯 SEMPRE presente
            patientId: patientId.toString(),
            
            // Contexto do pagamento
            appointmentId: appointmentId?.toString() || null,
            doctorId: doctorId?.toString() || null,
            
            // Dados financeiros
            amount: Number(amount),
            paymentMethod: normalizePaymentMethod(paymentMethod),
            
            // Metadados
            notes: notes || '',
            requestedBy: req.user?._id?.toString() || 'system',
            requestedAt: new Date().toISOString(),
            
            // Flags de controle
            isMultiPayment: type === 'multi_payment' || isMultiPayment,
            
            // Dados específicos por tipo
            ...(type === 'multi_payment' && {
                debitIds: debitIds.map(id => id.toString()),
                payments: payments.map(p => ({
                    ...p,
                    paymentMethod: normalizePaymentMethod(p.paymentMethod || paymentMethod)
                })),
                totalAmount: payments.reduce((sum, p) => sum + (p.amount || 0), 0)
            }),
            
            // Source tracking
            source: 'v2_api',
            apiVersion: '2.0'
        };

        // ========================================
        // 🚀 PUBLICA EVENTO: PAYMENT_PROCESS_REQUESTED
        // ========================================
        const eventResult = await publishEvent(
            EventTypes.PAYMENT_PROCESS_REQUESTED,
            normalizedPayload,
            {
                correlationId,
                idempotencyKey,
                aggregateType: 'payment',
                aggregateId: appointmentId || patientId,
                metadata: {
                    source: 'payment_api_v2',
                    userId: req.user?._id?.toString(),
                    ip: req.ip,
                    userAgent: req.headers['user-agent'],
                    validationVersion: '2.0-blindado'
                }
            }
        );

        console.log(`[PaymentV2] Evento publicado: ${eventResult.eventId}`, {
            correlationId,
            type,
            appointmentId: normalizedPayload.appointmentId,
            patientId: normalizedPayload.patientId,
            amount: normalizedPayload.amount,
            queue: eventResult.queue,
            jobId: eventResult.jobId
        });

        // ========================================
        // ✅ RETORNA 202 ACCEPTED (não espera processamento)
        // ========================================
        res.status(202).json({
            success: true,
            message: 'Pagamento enfileirado para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                idempotencyKey,
                jobId: eventResult.jobId,
                status: 'pending',
                type,
                amount: normalizedPayload.amount,
                paymentMethod: normalizedPayload.paymentMethod,
                checkStatusUrl: `/api/v2/payments/status/${eventResult.eventId}`
            }
        });

    } catch (error) {
        console.error('[PaymentV2] Erro ao publicar evento:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao iniciar pagamento: ' + error.message,
            code: 'PUBLISH_ERROR'
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
        // ========================================
        // 🛡️ VALIDAÇÃO RIGOROSA
        // ========================================
        if (!isValidObjectId(patientId)) {
            return res.status(400).json({
                success: false,
                error: 'ID de paciente inválido',
                code: 'INVALID_PATIENT_ID'
            });
        }

        if (!payments?.length || !debitIds?.length || !totalAmount || totalAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Dados de pagamento inválidos',
                code: 'INVALID_PAYMENT_DATA',
                details: {
                    hasPayments: !!payments?.length,
                    hasDebitIds: !!debitIds?.length,
                    totalAmount
                }
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
                error: 'Não há débitos pendentes para este paciente',
                code: 'NO_PENDING_DEBITS'
            });
        }

        // ========================================
        // 🎯 GERA IDS
        // ========================================
        const correlationId = `payment_multi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const idempotencyKey = `payment_multi_${patientId}_${debitIds.sort().join('_')}`;

        // ========================================
        // 📦 NORMALIZAÇÃO FORÇADA
        // ========================================
        const normalizedPayload = {
            type: 'multi_payment',          // 🎯 SEMPRE definido
            patientId: patientId.toString(),
            appointmentId: null,            // null explicitamente
            payments: payments.map(p => ({
                ...p,
                paymentMethod: normalizePaymentMethod(p.paymentMethod || 'dinheiro')
            })),
            debitIds: debitIds.map(id => id.toString()),
            totalAmount: Number(totalAmount),
            requestedBy: req.user?._id?.toString() || 'system',
            requestedAt: new Date().toISOString(),
            isMultiPayment: true,
            source: 'v2_api_multi',
            apiVersion: '2.0'
        };

        // ========================================
        // 🚀 PUBLICA EVENTO
        // ========================================
        const eventResult = await publishEvent(
            EventTypes.PAYMENT_PROCESS_REQUESTED,
            normalizedPayload,
            {
                correlationId,
                idempotencyKey,
                aggregateType: 'payment',
                aggregateId: patientId,
                priority: 7, // Prioridade alta para pagamentos
                metadata: {
                    source: 'payment_multi_api_v2',
                    userId: req.user?._id?.toString(),
                    validationVersion: '2.0-blindado'
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
                type: 'multi_payment',
                totalAmount,
                debitsCount: debitIds.length,
                checkStatusUrl: `/api/v2/payments/status/${eventResult.eventId}`
            }
        });

    } catch (error) {
        console.error('[PaymentV2] Erro no payment-multi:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao iniciar pagamento múltiplo: ' + error.message,
            code: 'MULTI_PAYMENT_ERROR'
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
                error: 'Evento não encontrado',
                code: 'EVENT_NOT_FOUND'
            });
        }

        // Busca pagamento relacionado (com validação de ObjectId)
        let payment = null;
        if (event.payload?.appointmentId && mongoose.Types.ObjectId.isValid(event.payload.appointmentId)) {
            try {
                payment = await Payment.findOne({ 
                    appointment: event.payload.appointmentId 
                }).select('status amount paymentMethod paidAt');
            } catch (err) {
                // Ignora erro de query - payment pode não existir ainda
                console.log('[PaymentV2] Payment não encontrado para appointment:', event.payload.appointmentId);
            }
        }

        // 🆕 Para pagamentos standalone (sem appointment), busca pelo patient + amount recente
        if (!payment && event.payload?.patientId && mongoose.Types.ObjectId.isValid(event.payload.patientId)) {
            try {
                const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
                payment = await Payment.findOne({
                    patient: event.payload.patientId,
                    amount: event.payload.amount,
                    status: 'paid',
                    createdAt: { $gte: fiveMinutesAgo }
                }).sort({ createdAt: -1 }).select('status amount paymentMethod paidAt');
            } catch (err) {
                console.log('[PaymentV2] Payment não encontrado para patient standalone:', event.payload.patientId);
            }
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
            error: 'Erro ao consultar status: ' + error.message,
            code: 'STATUS_QUERY_ERROR'
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
        // ========================================
        // 🛡️ VALIDAÇÃO
        // ========================================
        if (!paymentId || !status) {
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios: paymentId, status',
                code: 'MISSING_WEBHOOK_FIELDS'
            });
        }

        if (!isValidObjectId(paymentId)) {
            return res.status(400).json({
                success: false,
                error: 'paymentId inválido',
                code: 'INVALID_PAYMENT_ID'
            });
        }

        const correlationId = `webhook_${gateway || 'unknown'}_${Date.now()}`;

        // Determina tipo de evento baseado no status
        const eventType = status === 'paid'
            ? EventTypes.PAYMENT_COMPLETED
            : EventTypes.PAYMENT_FAILED;

        // Busca contexto do payment (patientId, appointmentId) para enriquecer eventos
        const paymentDoc = await Payment.findById(paymentId)
            .select('patient appointment status')
            .lean();

        if (!paymentDoc) {
            return res.status(404).json({
                success: false,
                error: 'Pagamento não encontrado',
                code: 'PAYMENT_NOT_FOUND'
            });
        }

        // ========================================
        // 📦 NORMALIZAÇÃO
        // ========================================
        const normalizedPayload = {
            type: 'webhook_confirmation',   // 🎯 SEMPRE definido
            paymentId: paymentId.toString(),
            patientId: paymentDoc.patient?.toString() || null,
            appointmentId: paymentDoc.appointment?.toString() || null,
            transactionId: transactionId || null,
            status,
            gateway: gateway || 'unknown',
            confirmedAt: new Date().toISOString(),
            previousStatus: paymentDoc.status,
            metadata,
            source: 'webhook',
            apiVersion: '2.0'
        };

        // ========================================
        // 🚀 PUBLICA EVENTO
        // ========================================
        const eventResult = await publishEvent(
            eventType,
            normalizedPayload,
            {
                correlationId,
                aggregateType: 'payment',
                aggregateId: paymentId,
                metadata: { 
                    source: 'payment_webhook', 
                    gateway,
                    validationVersion: '2.0-blindado'
                }
            }
        );

        // 🔄 PUBLICA PAYMENT_STATUS_CHANGED — sincroniza appointment/session no sistema
        await publishEvent(
            EventTypes.PAYMENT_STATUS_CHANGED,
            {
                type: 'status_changed',
                paymentId: paymentId.toString(),
                patientId: paymentDoc.patient?.toString() || null,
                appointmentId: paymentDoc.appointment?.toString() || null,
                previousStatus: paymentDoc.status,
                status,
                changedAt: new Date().toISOString(),
                source: 'webhook'
            },
            {
                correlationId,
                aggregateType: 'payment',
                aggregateId: paymentId,
                metadata: { source: 'payment_webhook', gateway }
            }
        ).catch(err =>
            console.warn('[PaymentV2] PAYMENT_STATUS_CHANGED não publicado (non-fatal):', err.message)
        );

        console.log(`[PaymentV2] Webhook processado: ${paymentId}`, {
            status,
            gateway,
            eventId: eventResult.eventId,
            type: 'webhook_confirmation'
        });

        res.json({
            success: true,
            message: `Webhook ${status} processado`,
            data: {
                eventId: eventResult.eventId,
                correlationId,
                type: 'webhook_confirmation'
            }
        });

    } catch (error) {
        console.error('[PaymentV2] Erro no webhook:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao processar webhook: ' + error.message,
            code: 'WEBHOOK_ERROR'
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
            error: 'Erro ao consultar fila: ' + error.message,
            code: 'QUEUE_STATUS_ERROR'
        });
    }
});

// ============================================
// PATCH /api/v2/payments/:id
// Atualiza pagamento existente - BLINDADO
// ============================================
router.patch('/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { amount, paymentMethod, status, serviceType, specialty, paymentDate } = req.body;

    // 1. Fail fast: ID válido?
    if (!isValidObjectId(id)) {
        return res.status(400).json({
            success: false,
            error: 'ID de pagamento inválido',
            code: 'INVALID_PAYMENT_ID'
        });
    }

    // 2. Fail fast: payload vazio?
    const hasChanges = amount !== undefined ||
                       paymentMethod !== undefined ||
                       status !== undefined ||
                       serviceType !== undefined ||
                       specialty !== undefined ||
                       paymentDate !== undefined;

    if (!hasChanges) {
        return res.status(400).json({
            success: false,
            error: 'Nenhum campo para atualizar',
            code: 'NO_CHANGES'
        });
    }

    try {
        // 3. Buscar payment
        const payment = await Payment.findById(id).lean();
        if (!payment) {
            return res.status(404).json({
                success: false,
                error: 'Pagamento não encontrado',
                code: 'PAYMENT_NOT_FOUND'
            });
        }

        // 4. Montar update
        const updateData = {
            ...(amount !== undefined && { amount }),
            ...(paymentMethod !== undefined && { paymentMethod }),
            ...(status !== undefined && { status }),
            ...(serviceType !== undefined && { serviceType }),
            ...(specialty !== undefined && { specialty }),
            ...(paymentDate !== undefined && { paymentDate: new Date(paymentDate) }),
            updatedAt: new Date()
        };

        // 🏦 FINANCIAL LOCK: se mudou para pago, precisa de paidAt
        if (status !== undefined && ['paid', 'completed', 'confirmed'].includes(status) && !payment.paidAt) {
            updateData.paidAt = new Date();
        }

        await Payment.findByIdAndUpdate(id, { $set: updateData });

        // 5. Publicar evento PAYMENT_UPDATED
        try {
            await publishEvent(
                EventTypes.PAYMENT_UPDATED,
                {
                    paymentId: id,
                    patientId: payment.patient?.toString?.(),
                    doctorId: payment.doctor?.toString?.(),
                    amount: updateData.amount ?? payment.amount,
                    status: updateData.status ?? payment.status,
                    paymentMethod: updateData.paymentMethod ?? payment.paymentMethod,
                    serviceType: updateData.serviceType ?? payment.serviceType,
                    specialty: updateData.specialty ?? payment.specialty,
                    paymentDate: updateData.paymentDate ?? payment.paymentDate,
                    sessionId: payment.session?.toString?.(),
                    appointmentId: payment.appointment?.toString?.(),
                    packageId: payment.package?.toString?.(),
                    previousStatus: payment.status,
                    updatedAt: new Date().toISOString()
                },
                { correlationId: `v2_payment_patch_${id}_${Date.now()}` }
            );
        } catch (pubErr) {
            logger.error(`[V2 PATCH ${id}] ⚠️ Falha ao publicar evento: ${pubErr.message}`);
            // Não falha a requisição — evento é side-effect
        }

        const updated = await Payment.findById(id).populate('patient doctor session');
        return res.json({
            success: true,
            data: updated,
            message: 'Pagamento atualizado com sucesso'
        });

    } catch (error) {
        logger.error(`[V2 PATCH ${id}] ❌ Erro: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'Erro ao atualizar pagamento',
            code: 'PAYMENT_UPDATE_ERROR'
        });
    }
});

// ============================================
// POST /api/v2/payments/bulk-settle
// Fecha sessões pós-pagas: marca pendentes como pagas + cria 1 recibo consolidado no caixa
// ============================================
router.post('/bulk-settle', auth, async (req, res) => {
    const { paymentIds, paymentMethod, totalAmount, notes } = req.body;

    if (!Array.isArray(paymentIds) || paymentIds.length === 0) {
        return res.status(400).json({ success: false, error: 'paymentIds obrigatório' });
    }

    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    try {
        const payments = await Payment.find({
            _id: { $in: paymentIds },
            status: { $in: ['pending', 'partial'] }
        }).session(mongoSession);

        if (payments.length === 0) {
            await mongoSession.abortTransaction();
            return res.status(400).json({ success: false, error: 'Nenhum payment pendente encontrado' });
        }

        const now = new Date();
        const patientId = payments[0].patient?.toString() || payments[0].patientId;
        const clinicId = payments[0].clinicId || 'default';
        const totalSettled = totalAmount || payments.reduce((s, p) => s + (p.amount || 0), 0);

        // 1. Marca cada sessão como paga — preserva paymentDate (data da sessão)
        for (const p of payments) {
            p.status = 'paid';
            p.paidAt = now;
            // NÃO altera p.paymentDate — mantém data original da sessão
            if (paymentMethod) p.paymentMethod = paymentMethod;
            await p.save({ session: mongoSession });
        }

        // 2. Atualiza appointments vinculados
        const appointmentIds = payments.filter(p => p.appointment).map(p => p.appointment.toString());
        if (appointmentIds.length > 0) {
            const Appointment = mongoose.model('Appointment');
            await Appointment.updateMany(
                { _id: { $in: appointmentIds } },
                { $set: { paymentStatus: 'paid', isPaid: true } },
                { session: mongoSession }
            );
        }

        // 3. Cria 1 recibo consolidado que aparece no caixa do dia
        const receipt = await Payment.create([{
            patient: payments[0].patient,
            patientId,
            doctor: payments[0].doctor,
            clinicId,
            amount: totalSettled,
            status: 'paid',
            paymentDate: now,
            serviceDate: now,
            paidAt: now,
            paymentMethod: paymentMethod || 'dinheiro',
            billingType: payments[0].billingType || 'particular',
            kind: 'monthly_settlement',
            settledPaymentIds: payments.map(p => p._id),
            notes: notes || `Fechamento de ${payments.length} sessão(ões)`,
            createdAt: now,
            updatedAt: now
        }], { session: mongoSession });

        await mongoSession.commitTransaction();

        logger.info('[V2 bulk-settle] Fechamento realizado', { count: payments.length, totalSettled, patientId, receiptId: receipt[0]._id });

        res.json({
            success: true,
            message: `${payments.length} sessão(ões) quitada(s)`,
            data: {
                settledCount: payments.length,
                totalSettled,
                paymentMethod,
                receiptId: receipt[0]._id
            }
        });

    } catch (error) {
        await mongoSession.abortTransaction();
        logger.error('[V2 bulk-settle] Erro:', error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        mongoSession.endSession();
    }
});

export default router;
