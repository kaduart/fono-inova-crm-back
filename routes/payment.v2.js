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
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { getQueue } from '../infrastructure/queue/queueConfig.js';
import Payment from '../models/Payment.js';
import { recordPaymentReceived } from '../services/financialLedgerService.js';
import Appointment from '../models/Appointment.js';
import PatientBalance from '../models/PatientBalance.js';
import { syncAffectedViews } from '../services/projections/syncAffectedViews.js';
import { transitionPaymentStatus } from '../services/paymentStatusService.js';

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
            const apptDoc = await Appointment.findById(appointmentId)
                .select('billingType package')
                .populate('package', 'paymentType model')
                .lean();
            if (!apptDoc) {
                return res.status(404).json({
                    success: false,
                    error: 'Agendamento não encontrado',
                    code: 'APPOINTMENT_NOT_FOUND',
                    appointmentId
                });
            }

            // 🛡️ GUARD: tipos que não permitem pagamento manual
            const billingType = apptDoc.billingType;
            const pkgPayType  = apptDoc.package?.paymentType || apptDoc.package?.model;
            const isPrepaid   = pkgPayType === 'full' || pkgPayType === 'prepaid';

            if (billingType === 'convenio') {
                return res.status(422).json({
                    success: false,
                    error: 'Convênio — pagamento gerenciado pela seguradora. Não é possível registrar pagamento manual.',
                    code: 'PAYMENT_NOT_ALLOWED_CONVENIO',
                    billingType
                });
            }
            if (billingType === 'liminar') {
                return res.status(422).json({
                    success: false,
                    error: 'Liminar judicial — crédito gerenciado pelo sistema. Não é possível registrar pagamento manual.',
                    code: 'PAYMENT_NOT_ALLOWED_LIMINAR',
                    billingType
                });
            }
            if (isPrepaid) {
                return res.status(422).json({
                    success: false,
                    error: 'Pacote pré-pago — dinheiro já entrou na compra do pacote. Não é possível registrar pagamento por sessão.',
                    code: 'PAYMENT_NOT_ALLOWED_PREPAID',
                    packagePaymentType: pkgPayType
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
// POST /api/v2/payments/create-sync
// Cria payment SÍNCRONO (para mark-as-paid de appointment sem payment)
// PADRÃO PER-SESSION: paciente por sessão paga NO DIA via tabela financeira.
// Antes de 2026-06-15: appointmentId NÃO era enviado → session_payment sem link de session/appointment
//   → aparecia como orphan_payment na reconciliação (ver reconciliation.service.js).
// A partir de 2026-06-15: appointmentId obrigatório quando é registro de appointment.
// ============================================
router.post('/create-sync', auth, async (req, res) => {
    const {
        patientId,
        doctorId,
        amount,
        paymentMethod = 'dinheiro',
        paymentDate,
        serviceDate,
        appointmentId,
        serviceType = 'session',
        notes,
        status = 'pending',
        billingType: requestedBillingType
    } = req.body;

    // 🛡️ Validação
    if (!patientId) {
        return res.status(400).json({
            success: false,
            error: 'patientId é obrigatório',
            code: 'MISSING_PATIENT_ID'
        });
    }
    if (!amount || amount <= 0) {
        return res.status(400).json({
            success: false,
            error: 'O valor do pagamento deve ser maior que zero. Edite o agendamento, defina um valor maior que zero e salve antes de marcar como pago.',
            code: 'INVALID_AMOUNT'
        });
    }
    if (appointmentId && !isValidObjectId(appointmentId)) {
        return res.status(400).json({
            success: false,
            error: 'appointmentId inválido',
            code: 'INVALID_APPOINTMENT_ID'
        });
    }

    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    try {
        const now = new Date();
        // Converte paymentDate para startOf('day') em Brasília para alinhar com o range do cashflow
        // new Date('2026-06-03') = T00:00:00Z (UTC midnight) = 21h anterior em Brasília → cai fora do range
        const financialDateBrasilia = paymentDate
            ? moment.tz(paymentDate, 'America/Sao_Paulo').startOf('day').toDate()
            : now;

        // 🎯 Resolve billingType corretamente:
        // 1. Usa o billingType explicitamente enviado no body
        // 2. Se houver appointment, usa o billingType do appointment
        // 3. Fallback: particular
        let resolvedBillingType = requestedBillingType;
        let resolvedPaymentMethod = paymentMethod;
        let appointmentDoc = null;

        if (!resolvedBillingType && appointmentId) {
            appointmentDoc = await Appointment.findById(appointmentId)
                .select('billingType insuranceProvider paymentMethod')
                .lean();

            if (appointmentDoc) {
                resolvedBillingType = appointmentDoc.billingType;

                // Se o appointment é convênio e não foi enviado paymentMethod específico,
                // normaliza para 'convenio' para consistência com o restante do sistema
                if (resolvedBillingType === 'convenio' && paymentMethod === 'dinheiro') {
                    resolvedPaymentMethod = 'convenio';
                }
            }
        }

        if (!resolvedBillingType) {
            resolvedBillingType = 'particular';
        }

        const paymentData = {
            patient: patientId,
            patientId: patientId.toString(),
            doctor: doctorId || null,
            amount,
            paymentMethod: resolvedPaymentMethod,
            paymentDate: paymentDate ? new Date(paymentDate) : now,
            financialDate: financialDateBrasilia,
            // serviceDate = data da sessão (regime de competência). Distinto de paymentDate (caixa).
            serviceDate: serviceDate ? new Date(serviceDate) : null,
            status,
            serviceType,
            notes: notes || '',
            kind: appointmentId ? 'appointment_payment' : 'session_payment',
            billingType: resolvedBillingType,
            createdAt: now,
            updatedAt: now,
            ...(appointmentId && {
                appointment: appointmentId,
                appointmentId: appointmentId.toString()
            })
        };

        if (['paid', 'completed', 'confirmed'].includes(status)) {
            paymentData.paidAt = now;
        }

        const [paymentDoc] = await Payment.create([paymentData], { session: mongoSession });

        // Vincula ao appointment
        if (appointmentId) {
            await Appointment.findByIdAndUpdate(
                appointmentId,
                {
                    $set: {
                        payment: paymentDoc._id,
                        paymentStatus: status,
                        isPaid: status === 'paid',
                        updatedAt: now
                    }
                },
                { session: mongoSession }
            );
        }

        // 🏦 LEDGER: registra payment_received se status é pago
        if (['paid', 'completed', 'confirmed'].includes(status)) {
            try {
                await recordPaymentReceived(
                    paymentDoc,
                    {
                        userId: req.user?._id?.toString(),
                        userName: req.user?.name,
                        correlationId: `create_sync_${paymentDoc._id}_${Date.now()}`
                    },
                    mongoSession
                );
            } catch (ledgerErr) {
                if (ledgerErr.code === 11000 || ledgerErr.message?.includes('duplicate key')) {
                    console.log(`[create-sync] Ledger entry já existe para payment ${paymentDoc._id}`);
                } else {
                    throw ledgerErr;
                }
            }
        }

        await mongoSession.commitTransaction();

        return res.status(201).json({
            success: true,
            data: paymentDoc.toObject(),
            message: 'Pagamento criado com sucesso'
        });
    } catch (error) {
        await mongoSession.abortTransaction();
        logger.error(`[V2 create-sync] ❌ Erro: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'Erro ao criar pagamento',
            code: 'PAYMENT_CREATE_ERROR'
        });
    } finally {
        await mongoSession.endSession();
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
    const { amount, paymentMethod, status, serviceType, specialty, paymentDate, notes, doctor, splitMethods, financialDate: financialDateBody } = req.body;

    // 1. Fail fast: ID válido?
    if (!isValidObjectId(id)) {
        return res.status(400).json({
            success: false,
            error: 'ID de pagamento inválido',
            code: 'INVALID_PAYMENT_ID'
        });
    }

    // Validação split
    if (splitMethods !== undefined) {
        if (!Array.isArray(splitMethods) || splitMethods.length < 2) {
            return res.status(400).json({ success: false, error: 'splitMethods deve ter pelo menos 2 entradas', code: 'INVALID_SPLIT' });
        }
        if (amount !== undefined) {
            const splitTotal = splitMethods.reduce((s, e) => s + (Number(e.amount) || 0), 0);
            if (Math.abs(splitTotal - amount) > 0.01) {
                return res.status(400).json({ success: false, error: `Total do split (${splitTotal}) não corresponde ao amount (${amount})`, code: 'SPLIT_AMOUNT_MISMATCH' });
            }
        }
    }

    // 2. Fail fast: payload vazio?
    const hasChanges = amount !== undefined ||
                       paymentMethod !== undefined ||
                       status !== undefined ||
                       serviceType !== undefined ||
                       specialty !== undefined ||
                       paymentDate !== undefined ||
                       notes !== undefined ||
                       doctor !== undefined ||
                       splitMethods !== undefined ||
                       financialDateBody !== undefined;

    if (!hasChanges) {
        return res.status(400).json({
            success: false,
            error: 'Nenhum campo para atualizar',
            code: 'NO_CHANGES'
        });
    }

    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    try {
        // 3. Buscar payment (dentro da transação para consistência)
        const payment = await Payment.findById(id).session(mongoSession).lean();
        
        if (!payment) {
            await mongoSession.abortTransaction();
            return res.status(404).json({
                success: false,
                error: 'Pagamento não encontrado',
                code: 'PAYMENT_NOT_FOUND'
            });
        }

        // 🛡️ BLOQUEIO: não permite quitar manualmente convênio, liminar ou pré-pago
        const blockedTypes = ['convenio', 'liminar'];
        if (blockedTypes.includes(payment.billingType)) {
            await mongoSession.abortTransaction();
            return res.status(400).json({
                success: false,
                error: `Pagamentos de ${payment.billingType} não podem ser quitados manualmente. O lançamento é automático pelo sistema.`,
                code: 'PAYMENT_TYPE_BLOCKED',
                billingType: payment.billingType
            });
        }
        if (payment.isFromPackage || payment.kind === 'package_consumed') {
            await mongoSession.abortTransaction();
            return res.status(400).json({
                success: false,
                error: 'Pagamentos pré-pagos (pacote) não podem ser quitados manualmente. O consumo é automático pelo sistema.',
                code: 'PAYMENT_TYPE_BLOCKED',
                kind: payment.kind
            });
        }

        // 4. Montar update
        const updateData = {
            ...(amount !== undefined && { amount }),
            // splitMethods: admin pode registrar múltiplas formas de pagamento
            ...(splitMethods !== undefined && {
                splitMethods,
                paymentMethod: splitMethods[0]?.method ?? payment.paymentMethod,
            }),
            ...(paymentMethod !== undefined && splitMethods === undefined && { paymentMethod }),
            ...(splitMethods === undefined && paymentMethod === undefined && {}),
            ...(status !== undefined && { status }),
            ...(serviceType !== undefined && { serviceType }),
            ...(specialty !== undefined && { specialty }),
            ...(notes !== undefined && { notes }),
            ...(doctor !== undefined && isValidObjectId(doctor) && { doctor }),
            ...(paymentDate !== undefined && { paymentDate: moment.tz(paymentDate, 'America/Sao_Paulo').startOf('day').toDate() }),
            // financialDate explícito (admin edit) define a data real do caixa
            ...(financialDateBody !== undefined && !payment.isFromPackage && {
                financialDate: moment.tz(financialDateBody, 'America/Sao_Paulo').startOf('day').toDate(),
            }),
            updatedAt: new Date()
        };

        // 🏦 FINANCIAL LOCK: se mudou para pago, precisa de paidAt e financialDate real
        if (status !== undefined && ['paid', 'completed', 'confirmed'].includes(status)) {
            if (!payment.paidAt) updateData.paidAt = new Date();
            // Só seta financialDate se o body não enviou uma data financeira explícita
            if (financialDateBody === undefined && !payment.financialDate && !payment.isFromPackage) {
                updateData.financialDate = new Date();
            }
        }

        // 🎯 STATUS TRANSITION: usa paymentStatusService se status mudou
        if (status !== undefined && status !== payment.status) {
            await transitionPaymentStatus(id, status, {
                session: mongoSession,
                paymentMethod: updateData.paymentMethod,
                financialDate: updateData.financialDate,
                paidAt: updateData.paidAt,
                userId: req.user?._id,
                reason: 'admin_manual_patch'
            });
            // Remove status do updateData pois já foi tratado pelo serviço
            delete updateData.status;
            delete updateData.paidAt;  // já setado pelo serviço
        }

        // Atualiza demais campos (se houver algo além de status)
        if (Object.keys(updateData).length > 0) {
            await Payment.findByIdAndUpdate(id, { $set: updateData }, { session: mongoSession });
        }

        // Commit antes de side-effects (evento + populate de retorno)
        await mongoSession.commitTransaction();

        // 5a. Sync appointment.paymentForms quando payment/split/data mudou (side-effect)
        if (splitMethods !== undefined || amount !== undefined || paymentMethod !== undefined || financialDateBody !== undefined) {
            const appointmentId = payment.appointment || payment.appointmentId;
            if (appointmentId) {
                try {
                    const payDate = updateData.financialDate || payment.financialDate || new Date();
                    let newPaymentForms;
                    if (splitMethods !== undefined) {
                        newPaymentForms = splitMethods.map(s => ({ amount: Number(s.amount), date: payDate, method: s.method }));
                    } else {
                        newPaymentForms = [{
                            amount: updateData.amount ?? payment.amount,
                            date: payDate,
                            method: updateData.paymentMethod ?? payment.paymentMethod,
                        }];
                    }
                    await Appointment.findByIdAndUpdate(appointmentId, { $set: { paymentForms: newPaymentForms } });
                    console.log('[PATCH payment] paymentForms sincronizado:', JSON.stringify(newPaymentForms));
                } catch (syncErr) {
                    console.error('[PATCH payment] Falha ao sincronizar paymentForms:', syncErr.message);
                }
            }
        }

        // 5b. Publicar evento PAYMENT_UPDATED (side-effect — try/catch isolado)
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
        await mongoSession.abortTransaction();
        logger.error(`[V2 PATCH ${id}] ❌ Erro: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'Erro ao atualizar pagamento',
            code: 'PAYMENT_UPDATE_ERROR'
        });
    } finally {
        await mongoSession.endSession();
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

        // 🛡️ FLOW GUARD: valida se cada payment permite quitação manual
        const { default: FinancialGuard } = await import('../services/financialGuard/index.js');
        try {
            await FinancialGuard.execute({
                context: 'SETTLE_PAYMENT',
                billingType: 'settle',
                payload: { paymentIds },
                session: mongoSession
            });
        } catch (flowErr) {
            await mongoSession.abortTransaction();
            return res.status(400).json({
                success: false,
                error: flowErr.message,
                code: flowErr.code || 'PAYMENT_FLOW_BLOCKED',
                meta: flowErr.meta || undefined
            });
        }

        // 1. Marca cada payment como pago — usa paymentStatusService (blindagem)
        for (const p of payments) {
            await transitionPaymentStatus(p._id, 'paid', {
                session: mongoSession,
                paymentMethod: paymentMethod || p.paymentMethod,
                paidAt: now,
                financialDate: p.paymentDate || now,
                userId: req.user?._id,
                reason: 'bulk_settle'
            });
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

        // 3. Atualiza packages afetados: recalcula totalPaid/balance a partir das sessions pagas
        const packageIds = [...new Set(payments.filter(p => p.package).map(p => p.package.toString()))];
        const affectedPackageIds = [];
        if (packageIds.length > 0) {
            const Package = mongoose.model('Package');
            const Session = mongoose.model('Session');
            for (const pkgId of packageIds) {
                const pkg = await Package.findById(pkgId).session(mongoSession).lean();
                if (!pkg) continue;
                
                const paidCount = await Session.countDocuments(
                    { package: pkgId, isPaid: true }
                ).session(mongoSession);
                
                const totalPaid = paidCount * (pkg.sessionValue || 0);
                const balance = Math.max(0, (pkg.totalValue || 0) - totalPaid);
                let financialStatus = 'unpaid';
                if (balance <= 0 && totalPaid > 0) financialStatus = 'paid';
                else if (totalPaid > 0) financialStatus = 'partially_paid';
                
                await Package.findByIdAndUpdate(
                    pkgId,
                    { $set: { totalPaid, balance, financialStatus, updatedAt: now } },
                    { session: mongoSession }
                );
                affectedPackageIds.push(pkgId);
            }
        }

        // 5. Cria 1 recibo consolidado que aparece no caixa do dia
        // serviceDate = data mais recente das sessões sendo quitadas (regime de competência)
        const _settledDates = payments
            .map(p => p.serviceDate || p.paymentDate)
            .filter(Boolean)
            .sort((a, b) => new Date(b) - new Date(a));
        const _receiptServiceDate = _settledDates[0] ? new Date(_settledDates[0]) : now;

        const receipt = await Payment.create([{
            patient: payments[0].patient,
            patientId,
            doctor: payments[0].doctor,
            clinicId,
            amount: totalSettled,
            status: 'paid',
            paymentDate: now,
            serviceDate: _receiptServiceDate,
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

        // 6. Rebuild síncrono das PackagesView para cada pacote afetado
        //    Domínio: Financial × TherapyPackage — fechamento de sessões pós-pagas
        if (affectedPackageIds.length > 0) {
            await Promise.allSettled(
                affectedPackageIds.map(pkgId =>
                    syncAffectedViews({
                        event: 'therapy_package.payment_settled',
                        packageId: pkgId,
                        correlationId: `bulk_settle_${pkgId}`
                    })
                )
            );
        }

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

// ============================================
// DELETE /api/v2/payments/:paymentId — ADMIN ONLY
// Remove payment com cascade: limpa appointment.payment + session.isPaid
// ============================================
router.delete('/:paymentId', auth, async (req, res) => {
    const { paymentId } = req.params;

    if (req.user?.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Acesso restrito a administradores', code: 'FORBIDDEN' });
    }
    if (!isValidObjectId(paymentId)) {
        return res.status(400).json({ success: false, error: 'paymentId inválido', code: 'INVALID_PAYMENT_ID' });
    }

    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    try {
        const payment = await Payment.findById(paymentId).session(mongoSession).lean();
        if (!payment) {
            await mongoSession.abortTransaction();
            return res.status(404).json({ success: false, error: 'Pagamento não encontrado', code: 'PAYMENT_NOT_FOUND' });
        }

        const cascade = { appointment: null, session: null };

        // 1. Limpa vínculo no appointment
        if (payment.appointment) {
            const appt = await Appointment.findById(payment.appointment).session(mongoSession).lean();
            if (appt && appt.payment?.toString() === paymentId) {
                await Appointment.findByIdAndUpdate(
                    payment.appointment,
                    { $set: { payment: null, paymentStatus: 'pending', isPaid: false } },
                    { session: mongoSession }
                );
                cascade.appointment = payment.appointment.toString();
            }
        }

        // 2. Limpa vínculo na session
        if (payment.session) {
            const Session = (await import('../models/Session.js')).default;
            await Session.findByIdAndUpdate(
                payment.session,
                { $set: { isPaid: false, paymentStatus: 'unpaid', payment: null } },
                { session: mongoSession }
            );
            cascade.session = payment.session.toString();
        }

        // 3. Remove o payment
        await Payment.deleteOne({ _id: paymentId }, { session: mongoSession });

        await mongoSession.commitTransaction();
        logger.info(`[DELETE payment] Admin ${req.user?._id} removeu payment ${paymentId}`, { cascade });

        return res.json({ success: true, message: 'Pagamento removido com sucesso', data: { paymentId, cascade } });

    } catch (error) {
        await mongoSession.abortTransaction();
        logger.error(`[DELETE payment] Erro: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message, code: 'DELETE_PAYMENT_ERROR' });
    } finally {
        mongoSession.endSession();
    }
});

export default router;
