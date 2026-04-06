// infrastructure/events/eventPublisher.js
import { Queue } from 'bullmq';
import { redisConnection } from '../queue/queueConfig.js';
import { appendEvent, eventExists } from './eventStoreService.js';
import { createContextLogger } from '../../utils/logger.js';

/**
 * Event Publisher
 * 
 * Publica eventos para filas BullMQ.
 * Todas as filas usam a mesma conexão Redis.
 */

// Filas disponíveis
const queues = {
    'appointment-processing': new Queue('appointment-processing', { connection: redisConnection }),
    'payment-processing': new Queue('payment-processing', { connection: redisConnection }),
    'balance-update': new Queue('balance-update', { connection: redisConnection }),
    'package-validation': new Queue('package-validation', { connection: redisConnection }),
    'sync-medical': new Queue('sync-medical', { connection: redisConnection }),
    'notification': new Queue('notification', { connection: redisConnection }),
    'cancel-orchestrator': new Queue('cancel-orchestrator', { connection: redisConnection }),
    'complete-orchestrator': new Queue('complete-orchestrator', { connection: redisConnection }),
    'invoice-processing': new Queue('invoice-processing', { connection: redisConnection }),
    'lead-processing': new Queue('lead-processing', { connection: redisConnection }),
    'followup-processing': new Queue('followup-processing', { connection: redisConnection }),
    'update-orchestrator': new Queue('update-orchestrator', { connection: redisConnection }),
    'whatsapp-notification': new Queue('whatsapp-notification', { connection: redisConnection }),
    'email-notification': new Queue('email-notification', { connection: redisConnection }),
    'totals-calculation': new Queue('totals-calculation', { connection: redisConnection }),
    'daily-closing': new Queue('daily-closing', { connection: redisConnection }),
    'patient-projection': new Queue('patient-projection', { connection: redisConnection }),
    'package-processing': new Queue('package-processing', { connection: redisConnection }),
    'insurance-orchestrator': new Queue('insurance-orchestrator', { connection: redisConnection }),
    'clinical-orchestrator': new Queue('clinical-orchestrator', { connection: redisConnection }),
    'clinical-session': new Queue('clinical-session', { connection: redisConnection }),
    'package-projection': new Queue('package-projection', { connection: redisConnection }),
    'billing-orchestrator': new Queue('billing-orchestrator', { connection: redisConnection }),
    'integration-orchestrator': new Queue('integration-orchestrator', { connection: redisConnection }),
    'lead-orchestrator-v2':    new Queue('lead-orchestrator-v2',    { connection: redisConnection }),
    'whatsapp-message-response': new Queue('whatsapp-message-response', { connection: redisConnection }),
    'whatsapp-inbound':          new Queue('whatsapp-inbound',          { connection: redisConnection }),
};

/**
 * Tipos de Eventos
 */
export const EventTypes = {
    // 🎯 Intenções (REQUESTED) → entrada da API
    APPOINTMENT_CREATE_REQUESTED: 'APPOINTMENT_CREATE_REQUESTED',
    APPOINTMENT_CANCEL_REQUESTED: 'APPOINTMENT_CANCEL_REQUESTED',
    APPOINTMENT_COMPLETE_REQUESTED: 'APPOINTMENT_COMPLETE_REQUESTED',
    PAYMENT_REQUESTED: 'PAYMENT_REQUESTED',
    PAYMENT_PROCESS_REQUESTED: 'PAYMENT_PROCESS_REQUESTED',
    BALANCE_UPDATE_REQUESTED: 'BALANCE_UPDATE_REQUESTED',
    DAILY_CLOSING_REQUESTED: 'DAILY_CLOSING_REQUESTED',
    TOTALS_RECALCULATE_REQUESTED: 'TOTALS_RECALCULATE_REQUESTED',
    
    // ✅ Resultados (COMPLETED/COMPLETED/FAILED) → saída dos workers
    APPOINTMENT_CREATED: 'APPOINTMENT_CREATED',
    APPOINTMENT_UPDATED: 'APPOINTMENT_UPDATED',
    APPOINTMENT_CANCELED: 'APPOINTMENT_CANCELED',
    APPOINTMENT_COMPLETED: 'APPOINTMENT_COMPLETED',
    APPOINTMENT_REJECTED: 'APPOINTMENT_REJECTED',
    APPOINTMENT_CONFIRMED: 'APPOINTMENT_CONFIRMED',
    APPOINTMENT_RESCHEDULED: 'APPOINTMENT_RESCHEDULED',
    APPOINTMENT_DELETED: 'APPOINTMENT_DELETED',
    
    // 📝 Updates (solicitação de alteração)
    APPOINTMENT_UPDATE_REQUESTED: 'APPOINTMENT_UPDATE_REQUESTED',
    LEAD_UPDATE_REQUESTED: 'LEAD_UPDATE_REQUESTED',
    INVOICE_UPDATE_REQUESTED: 'INVOICE_UPDATE_REQUESTED',
    PAYMENT_UPDATE_REQUESTED: 'PAYMENT_UPDATE_REQUESTED',
    
    SESSION_COMPLETED: 'SESSION_COMPLETED',
    SESSION_CANCELED: 'SESSION_CANCELED',
    SESSION_PAYMENT_RECEIVED: 'SESSION_PAYMENT_RECEIVED',
    
    PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
    
    // 💰 Payment V2 - Eventos de CRUD para projeção
    PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
    PAYMENT_UPDATED: 'PAYMENT_UPDATED',
    PAYMENT_DELETED: 'PAYMENT_DELETED',
    
    // 💰 Balance V2 - Eventos
    BALANCE_DEBIT_REQUESTED: 'BALANCE_DEBIT_REQUESTED',
    BALANCE_UPDATE_REQUESTED: 'BALANCE_UPDATE_REQUESTED',
    BALANCE_DELETE_REQUESTED: 'BALANCE_DELETE_REQUESTED',
    
    // 📦 Package V2 - Eventos de CRUD para projeção
    PACKAGE_CREATE_REQUESTED: 'PACKAGE_CREATE_REQUESTED',
    PACKAGE_CREATE_FAILED: 'PACKAGE_CREATE_FAILED',
    PACKAGE_CREATED: 'PACKAGE_CREATED',
    PACKAGE_UPDATED: 'PACKAGE_UPDATED',
    PACKAGE_CANCELLED: 'PACKAGE_CANCELLED',
    PACKAGE_CREDIT_CONSUMED: 'PACKAGE_CREDIT_CONSUMED',
    PACKAGE_NO_CREDIT: 'PACKAGE_NO_CREDIT',
    
    INSURANCE_GUIDE_CONSUMED: 'INSURANCE_GUIDE_CONSUMED',
    LIMINAR_REVENUE_RECOGNIZED: 'LIMINAR_REVENUE_RECOGNIZED',
    
    // 💰 Faturas
    INVOICE_PER_SESSION_CREATE: 'INVOICE_PER_SESSION_CREATE',
    INVOICE_CREATED: 'INVOICE_CREATED',
    INVOICE_PAID: 'INVOICE_PAID',
    INVOICE_OVERDUE: 'INVOICE_OVERDUE',
    INVOICE_CANCELED: 'INVOICE_CANCELED',
    
    // 📋 Lotes Convênio
    INSURANCE_BATCH_CREATED: 'INSURANCE_BATCH_CREATED',
    INSURANCE_BATCH_PROCESSING: 'INSURANCE_BATCH_PROCESSING',
    INSURANCE_BATCH_SEALED: 'INSURANCE_BATCH_SEALED',
    INSURANCE_BATCH_SENT: 'INSURANCE_BATCH_SENT',
    INSURANCE_BATCH_RECEIVED: 'INSURANCE_BATCH_RECEIVED',
    INSURANCE_BATCH_COMPLETED: 'INSURANCE_BATCH_COMPLETED',
    INSURANCE_ITEM_APPROVED: 'INSURANCE_ITEM_APPROVED',
    INSURANCE_ITEM_REJECTED: 'INSURANCE_ITEM_REJECTED',
    INSURANCE_PAYMENT_RECEIVED: 'INSURANCE_PAYMENT_RECEIVED',
    INSURANCE_GLOSA: 'INSURANCE_GLOSA',
    
    // 🔄 Notificações
    NOTIFICATION_REQUESTED: 'NOTIFICATION_REQUESTED',
    NOTIFICATION_SENT: 'NOTIFICATION_SENT',
    NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
    NOTIFICATION_DELIVERED: 'NOTIFICATION_DELIVERED',
    
    // 💬 Canais específicos
    WHATSAPP_MESSAGE_REQUESTED: 'WHATSAPP_MESSAGE_REQUESTED',
    WHATSAPP_MESSAGE_SENT: 'WHATSAPP_MESSAGE_SENT',
    WHATSAPP_MESSAGE_FAILED: 'WHATSAPP_MESSAGE_FAILED',
    EMAIL_MESSAGE_REQUESTED: 'EMAIL_MESSAGE_REQUESTED',
    EMAIL_MESSAGE_SENT: 'EMAIL_MESSAGE_SENT',
    EMAIL_MESSAGE_FAILED: 'EMAIL_MESSAGE_FAILED',
    SMS_MESSAGE_REQUESTED: 'SMS_MESSAGE_REQUESTED',
    
    // 🔄 Sync
    SYNC_MEDICAL_EVENT: 'SYNC_MEDICAL_EVENT',
    
    // 👤 Patients V2
    PATIENT_CREATE_REQUESTED: 'PATIENT_CREATE_REQUESTED',
    PATIENT_UPDATE_REQUESTED: 'PATIENT_UPDATE_REQUESTED',
    PATIENT_DELETE_REQUESTED: 'PATIENT_DELETE_REQUESTED',
    PATIENT_CREATED: 'PATIENT_CREATED',
    PATIENT_UPDATED: 'PATIENT_UPDATED',
    PATIENT_DELETED: 'PATIENT_DELETED',
    PATIENT_CREATE_FAILED: 'PATIENT_CREATE_FAILED',
    PATIENT_VIEW_REBUILD_REQUESTED: 'PATIENT_VIEW_REBUILD_REQUESTED',
    
    // 👨‍⚕️ Doctors V2
    DOCTOR_CREATE_REQUESTED: 'DOCTOR_CREATE_REQUESTED',
    DOCTOR_UPDATE_REQUESTED: 'DOCTOR_UPDATE_REQUESTED',
    DOCTOR_DELETE_REQUESTED: 'DOCTOR_DELETE_REQUESTED',
    DOCTOR_DEACTIVATE_REQUESTED: 'DOCTOR_DEACTIVATE_REQUESTED',
    DOCTOR_REACTIVATE_REQUESTED: 'DOCTOR_REACTIVATE_REQUESTED',
    DOCTOR_CREATED: 'DOCTOR_CREATED',
    DOCTOR_UPDATED: 'DOCTOR_UPDATED',
    DOCTOR_DELETED: 'DOCTOR_DELETED',
    
    // 👤 Leads
    LEAD_CREATED: 'LEAD_CREATED',
    LEAD_UPDATED: 'LEAD_UPDATED',
    LEAD_CONVERTED: 'LEAD_CONVERTED',
    
    // 📞 Followups
    FOLLOWUP_REQUESTED: 'FOLLOWUP_REQUESTED',
    FOLLOWUP_SCHEDULED: 'FOLLOWUP_SCHEDULED',
    FOLLOWUP_SENT: 'FOLLOWUP_SENT',
    FOLLOWUP_FAILED: 'FOLLOWUP_FAILED',
    FOLLOWUP_RESPONSE_RECEIVED: 'FOLLOWUP_RESPONSE_RECEIVED',
    
    // 💬 WhatsApp inbound (mensagem recebida do webhook → processamento async)
    WHATSAPP_MESSAGE_RECEIVED: 'WHATSAPP_MESSAGE_RECEIVED',

    // 💬 WhatsApp Response Tracking
    MESSAGE_RESPONSE_DETECTED: 'MESSAGE_RESPONSE_DETECTED',
    
    // 💰 Financeiro - Totals
    TOTALS_RECALCULATE_REQUESTED: 'TOTALS_RECALCULATE_REQUESTED',
    TOTALS_RECALCULATED: 'TOTALS_RECALCULATED',
    DAILY_CLOSING_REQUESTED: 'DAILY_CLOSING_REQUESTED',

    // 🔗 Integration Layer — eventos traduzidos entre domínios
    APPOINTMENT_BILLING_REQUESTED: 'APPOINTMENT_BILLING_REQUESTED',
    SESSION_BILLING_REQUESTED: 'SESSION_BILLING_REQUESTED',

    // 💳 Payment V2 — ciclo de vida explícito (migração do post('save') hook)
    PAYMENT_CREATED: 'PAYMENT_CREATED',               // Phase 1: publicado pelo worker, hook ainda ativo
    PAYMENT_STATUS_CHANGED: 'PAYMENT_STATUS_CHANGED', // Phase 2+: substitui o hook quando consumer existir
    PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
    PAYMENT_CANCELLED: 'PAYMENT_CANCELLED',
    INSURANCE_PAYMENT_RECOGNIZED: 'INSURANCE_PAYMENT_RECOGNIZED',
    
    // 🔗 Integration Layer — eventos traduzidos entre domínios
    APPOINTMENT_BILLING_REQUESTED: 'APPOINTMENT_BILLING_REQUESTED',
    SESSION_BILLING_REQUESTED: 'SESSION_BILLING_REQUESTED',
};

/**
 * Mapeamento de eventos para filas
 */
const eventToQueueMap = {
    // Intenções → Workers de orquestração
    [EventTypes.APPOINTMENT_CREATE_REQUESTED]: 'appointment-processing',
    [EventTypes.APPOINTMENT_CANCEL_REQUESTED]: 'cancel-orchestrator',
    [EventTypes.APPOINTMENT_COMPLETE_REQUESTED]: 'complete-orchestrator',
    [EventTypes.APPOINTMENT_UPDATE_REQUESTED]: 'update-orchestrator',
    [EventTypes.PAYMENT_REQUESTED]: 'payment-processing',
    [EventTypes.PAYMENT_PROCESS_REQUESTED]: 'payment-processing',
    [EventTypes.PAYMENT_UPDATE_REQUESTED]: 'payment-processing',
    [EventTypes.BALANCE_UPDATE_REQUESTED]: 'balance-update',
    [EventTypes.BALANCE_DEBIT_REQUESTED]: 'balance-update',
    [EventTypes.BALANCE_DELETE_REQUESTED]: 'balance-update',
    [EventTypes.DAILY_CLOSING_REQUESTED]: 'daily-closing',
    [EventTypes.TOTALS_RECALCULATE_REQUESTED]: 'totals-calculation',
    [EventTypes.TOTALS_RECALCULATED]: [],
    
    // Resultados → Workers de reação
    [EventTypes.APPOINTMENT_CREATED]: ['notification', 'patient-projection', 'clinical-orchestrator'],
    [EventTypes.APPOINTMENT_UPDATED]: ['notification', 'patient-projection'],
    [EventTypes.APPOINTMENT_CANCELED]: ['sync-medical', 'patient-projection', 'clinical-orchestrator'],
    [EventTypes.APPOINTMENT_COMPLETED]: ['sync-medical', 'patient-projection', 'integration-orchestrator', 'lead-orchestrator-v2'],
    [EventTypes.APPOINTMENT_REJECTED]: 'notification',
    [EventTypes.APPOINTMENT_CONFIRMED]: ['notification', 'patient-projection'],
    [EventTypes.APPOINTMENT_RESCHEDULED]: ['notification', 'patient-projection'],
    [EventTypes.APPOINTMENT_DELETED]: ['notification', 'patient-projection', 'clinical-orchestrator'],
    
    // Sessions
    // NOTA: SESSION_COMPLETED não vai para sync-medical porque o billing
    // é acionado por PAYMENT_COMPLETED (criado pelo CompleteOrchestrator)
    [EventTypes.SESSION_COMPLETED]: ['package-projection', 'patient-projection', 'clinical-session', 'integration-orchestrator'],
    [EventTypes.SESSION_CANCELED]: ['package-projection', 'sync-medical', 'patient-projection', 'clinical-session'],
    [EventTypes.SESSION_PAYMENT_RECEIVED]: ['sync-medical', 'patient-projection'],
    
    // Payments
    [EventTypes.PAYMENT_COMPLETED]: ['notification', 'integration-orchestrator', 'lead-orchestrator-v2'],
    [EventTypes.PAYMENT_FAILED]: 'notification',
    [EventTypes.PAYMENT_RECEIVED]: ['balance-update', 'patient-projection'],
    [EventTypes.PAYMENT_UPDATED]: ['balance-update', 'patient-projection'],
    [EventTypes.PAYMENT_DELETED]: ['balance-update', 'patient-projection'],
    
    // Packages
    [EventTypes.PACKAGE_CREATE_REQUESTED]: 'package-processing',
    [EventTypes.PACKAGE_CREATE_FAILED]: 'notification',
    [EventTypes.PATIENT_CREATE_REQUESTED]: ['patient-projection'],
    [EventTypes.PATIENT_CREATED]: ['patient-projection'],
    [EventTypes.PATIENT_UPDATED]: ['patient-projection'],
    [EventTypes.PACKAGE_CREATED]: ['package-projection', 'package-validation', 'patient-projection'],
    [EventTypes.PACKAGE_UPDATED]: ['package-projection', 'package-validation', 'patient-projection'],
    [EventTypes.PACKAGE_CANCELLED]: ['package-projection', 'package-validation', 'patient-projection'],
    [EventTypes.PACKAGE_CREDIT_CONSUMED]: 'package-validation',
    [EventTypes.PACKAGE_NO_CREDIT]: 'notification',
    
    // Insurance
    [EventTypes.INSURANCE_BATCH_CREATED]: 'insurance-orchestrator',
    [EventTypes.INSURANCE_BATCH_PROCESSING]: 'insurance-orchestrator',
    [EventTypes.INSURANCE_BATCH_SEALED]: 'insurance-orchestrator',
    [EventTypes.INSURANCE_BATCH_SENT]: 'insurance-orchestrator',
    [EventTypes.INSURANCE_BATCH_RECEIVED]: 'insurance-orchestrator',
    [EventTypes.INSURANCE_BATCH_COMPLETED]: 'insurance-orchestrator',
    [EventTypes.INSURANCE_ITEM_APPROVED]: 'insurance-orchestrator',
    [EventTypes.INSURANCE_ITEM_REJECTED]: 'insurance-orchestrator',
    [EventTypes.INSURANCE_PAYMENT_RECEIVED]: 'insurance-orchestrator',
    
    [EventTypes.NOTIFICATION_REQUESTED]: 'notification',
    [EventTypes.SYNC_MEDICAL_EVENT]: 'sync-medical',
    
    // 💰 Faturas
    [EventTypes.INVOICE_PER_SESSION_CREATE]: 'invoice-processing',
    [EventTypes.INVOICE_CREATED]: 'notification',
    [EventTypes.INVOICE_PAID]: 'notification',
    [EventTypes.INVOICE_OVERDUE]: 'notification',
    [EventTypes.INVOICE_CANCELED]: 'notification',
    
    // 📋 Glosa → SyncMedical (único evento de convênio sem dono no fluxo principal)
    [EventTypes.INSURANCE_GLOSA]: 'sync-medical',
    
    // 👤 Leads → Lead Processing
    [EventTypes.LEAD_CREATED]: 'lead-processing',
    [EventTypes.LEAD_UPDATED]: 'lead-processing',
    [EventTypes.LEAD_CONVERTED]: 'lead-processing',
    
    // 📞 Followups → Followup Processing
    [EventTypes.FOLLOWUP_REQUESTED]: 'followup-processing',
    [EventTypes.FOLLOWUP_SCHEDULED]: 'followup-processing',
    [EventTypes.FOLLOWUP_SENT]: 'notification',
    [EventTypes.FOLLOWUP_FAILED]: 'notification',
    [EventTypes.FOLLOWUP_RESPONSE_RECEIVED]: 'notification',
    
    // 💬 WhatsApp inbound
    [EventTypes.WHATSAPP_MESSAGE_RECEIVED]: 'whatsapp-inbound',

    // 💬 WhatsApp Response Tracking
    [EventTypes.MESSAGE_RESPONSE_DETECTED]: 'whatsapp-message-response',
    
    // 🔔 Notificações
    [EventTypes.NOTIFICATION_REQUESTED]: 'notification',
    [EventTypes.NOTIFICATION_SENT]: 'notification',
    [EventTypes.NOTIFICATION_FAILED]: 'notification',
    [EventTypes.WHATSAPP_MESSAGE_REQUESTED]: 'whatsapp-notification',
    [EventTypes.WHATSAPP_MESSAGE_SENT]: 'notification',
    [EventTypes.WHATSAPP_MESSAGE_FAILED]: 'notification',
    [EventTypes.EMAIL_MESSAGE_REQUESTED]: 'email-notification',
    [EventTypes.EMAIL_MESSAGE_SENT]: 'notification',
    [EventTypes.EMAIL_MESSAGE_FAILED]: 'notification',

    // 🔗 Integration Layer — eventos traduzidos
    [EventTypes.APPOINTMENT_BILLING_REQUESTED]: 'billing-orchestrator',
    [EventTypes.SESSION_BILLING_REQUESTED]: 'billing-orchestrator',

    // 💳 Payment V2 — ciclo de vida
    // Phase 1: só patient-projection (hook ainda cobre o resto)
    // Phase 2: adicionar 'appointment-processing' quando handler for criado
    [EventTypes.PAYMENT_CREATED]:              'patient-projection',
    [EventTypes.PAYMENT_STATUS_CHANGED]:       'patient-projection',
    [EventTypes.PAYMENT_CONFIRMED]:            ['patient-projection', 'balance-update'],
    [EventTypes.PAYMENT_CANCELLED]:            'patient-projection',
    [EventTypes.INSURANCE_PAYMENT_RECOGNIZED]: ['patient-projection', 'balance-update'],
};

/**
 * Publica um evento para a fila apropriada
 * 
 * @param {String} eventType - Tipo do evento (use EventTypes)
 * @param {Object} payload - Dados do evento
 * @param {Object} options - Opções
 * @param {String} options.correlationId - ID de correlação
 * @param {String} options.idempotencyKey - Chave de idempotência (aggregateId + ação)
 * @param {Number} options.delay - Delay em ms
 * @param {Number} options.priority - Prioridade (1-10)
 * @returns {Object} Resultado da publicação
 */
/**
 * Publica um evento para a fila apropriada
 * 
 * FLUXO:
 * 1. Gera eventId único
 * 2. PERSISTE no Event Store (append-only)
 * 3. ENVIA para fila BullMQ
 * 4. Retorna referências
 * 
 * @param {String} eventType - Tipo do evento (use EventTypes)
 * @param {Object} payload - Dados do evento
 * @param {Object} options - Opções
 * @param {String} options.correlationId - ID de correlação
 * @param {String} options.idempotencyKey - Chave de idempotência
 * @param {String} options.aggregateType - Tipo do aggregate (appointment, lead, etc)
 * @param {String} options.aggregateId - ID do aggregate
 * @param {Number} options.delay - Delay em ms
 * @param {Number} options.priority - Prioridade (1-10)
 * @param {Object} options.metadata - Metadados extras
 * @returns {Object} Resultado da publicação
 */
export async function publishEvent(eventType, payload, options = {}) {
    const { 
        correlationId = null, 
        idempotencyKey = null,
        aggregateType = null,
        aggregateId = null,
        delay = 0, 
        priority = 5,
        metadata = {}
    } = options;
    
    const log = createContextLogger(correlationId, 'event_publisher');
    
    // 🔥 LOG DIAGNÓSTICO - ENTRADA
    console.log(`🔥 [EVENT_PUBLISHER] ========== ENTRADA ==========`);
    console.log(`🔥 [EVENT_PUBLISHER] eventType: ${eventType}`);
    console.log(`🔥 [EVENT_PUBLISHER] correlationId: ${correlationId}`);
    console.log(`🔥 [EVENT_PUBLISHER] payload.appointmentId: ${payload?.appointmentId}`);
    console.log(`🔥 [EVENT_PUBLISHER] =================================`);
    
    log.info('publish_start', 'Publicando evento', { eventType });
    
    const queueNames = eventToQueueMap[eventType];
    
    console.log(`🔥 [EVENT_PUBLISHER] queueNames encontrado:`, queueNames);
    
    if (!queueNames) {
        console.error(`❌ [EVENT_PUBLISHER] UNKNOWN_EVENT_TYPE: ${eventType}`);
        throw new Error(`UNKNOWN_EVENT_TYPE: ${eventType}`);
    }
    
    // Suporta string única ou array de filas
    const queuesToPublish = Array.isArray(queueNames) ? queueNames : [queueNames];
    
    // Determina aggregate type/id do payload se não fornecido
    const finalAggregateType = aggregateType || extractAggregateType(eventType, payload);
    const finalAggregateId = aggregateId || extractAggregateId(payload);
    
    // Gera idempotencyKey se não fornecida
    const finalIdempotencyKey = idempotencyKey || generateIdempotencyKey(eventType, payload, finalAggregateId);
    
    console.log(`🔥 [EVENT_PUBLISHER] finalIdempotencyKey: ${finalIdempotencyKey}`);
    
    // 🛡️ IDEMPOTÊNCIA: Verifica se já foi processado
    if (finalIdempotencyKey) {
        console.log(`🔥 [EVENT_PUBLISHER] Verificando idempotência...`);
        const alreadyExists = await eventExists(finalIdempotencyKey);
        console.log(`🔥 [EVENT_PUBLISHER] alreadyExists: ${alreadyExists}`);
        if (alreadyExists) {
            console.warn(`⚠️ [EVENT_PUBLISHER] DUPLICADO! Ignorando ${eventType}`);
            log.warn('duplicate_event', 'Evento duplicado ignorado', {
                eventType,
                idempotencyKey: finalIdempotencyKey
            });
            return {
                eventId: 'duplicate',
                eventType,
                duplicate: true,
                idempotencyKey: finalIdempotencyKey,
                queue: queueName
            };
        }
    }
    
    // ============ PASSO 1: PERSISTE NO EVENT STORE ============
    const eventStoreData = {
        eventType,
        aggregateType: finalAggregateType,
        aggregateId: finalAggregateId,
        payload,
        idempotencyKey: finalIdempotencyKey,
        correlationId,
        metadata: {
            correlationId,
            source: metadata.source || 'eventPublisher',
            userId: metadata.userId,
            ip: metadata.ip,
            userAgent: metadata.userAgent
        }
    };
    
    const storedEvent = await appendEvent(eventStoreData);
    const eventId = storedEvent.eventId;
    
    log.info('event_stored', 'Evento persistido no Event Store', {
        eventId,
        eventType,
        aggregateType: finalAggregateType
    });
    
    // ============ PASSO 2: ENVIA PARA FILA(S) ============
    const jobData = {
        eventId,              // UUID do Event Store
        eventType,
        correlationId: correlationId || eventId,
        idempotencyKey: finalIdempotencyKey,
        aggregateType: finalAggregateType,
        aggregateId: finalAggregateId,
        payload,
        publishedAt: new Date().toISOString(),
        eventStoreId: storedEvent._id // Referência ao Event Store
    };
    
    const jobOptions = {
        delay,
        priority,
        attempts: 5,
        backoff: {
            type: 'exponential',
            delay: 1000
        },
        removeOnComplete: {
            age: 24 * 3600,
            count: 1000
        },
        removeOnFail: {
            age: 7 * 24 * 3600
        }
    };
    
    // Publica para todas as filas configuradas
    const jobs = [];
    console.log(`🔥 [EVENT_PUBLISHER] queuesToPublish:`, queuesToPublish);
    
    for (const qName of queuesToPublish) {
        console.log(`🔥 [EVENT_PUBLISHER] Processando fila: ${qName}`);
        const queue = queues[qName];
        if (!queue) {
            console.error(`❌ [EVENT_PUBLISHER] Fila ${qName} NÃO ENCONTRADA no objeto queues!`);
            log.error('queue_not_found', `Fila ${qName} não encontrada`, { eventType });
            continue;
        }
        
        console.log(`🔥 [EVENT_PUBLISHER] Adicionando job à fila ${qName}...`);
        try {
            const job = await queue.add(eventType, jobData, jobOptions);
            console.log(`✅ [EVENT_PUBLISHER] Job criado: ${job.id} na fila ${qName}`);
            jobs.push({ queue: qName, jobId: job.id });
            
            log.info('event_queued', 'Evento enviado para fila', {
                eventType,
                eventId,
                queue: qName,
                jobId: job.id
            });
        } catch (addError) {
            console.error(`❌ [EVENT_PUBLISHER] ERRO ao adicionar job:`, addError.message);
            throw addError;
        }
    }
    
    console.log(`🔥 [EVENT_PUBLISHER] Total jobs criados: ${jobs.length}`);
    console.log(`🔥 [EVENT_PUBLISHER] ====== FIM ======`);
    
    return {
        eventId,
        eventType,
        jobs,
        correlationId: jobData.correlationId,
        idempotencyKey: finalIdempotencyKey,
        queues: queuesToPublish,
        eventStoreId: storedEvent._id,
        duplicate: storedEvent.duplicate || false
    };
}

/**
 * Extrai aggregate type do eventType ou payload
 */
function extractAggregateType(eventType, payload) {
    // Do eventType
    if (eventType.includes('APPOINTMENT')) return 'appointment';
    if (eventType.includes('LEAD')) return 'lead';
    if (eventType.includes('PATIENT')) return 'patient';
    if (eventType.includes('PAYMENT')) return 'payment';
    if (eventType.includes('INVOICE')) return 'invoice';
    if (eventType.includes('PACKAGE')) return 'package';
    if (eventType.includes('FOLLOWUP')) return 'followup';
    if (eventType.includes('NOTIFICATION')) return 'notification';
    if (eventType.includes('SESSION')) return 'session';
    if (eventType.includes('INSURANCE')) return 'insurance';
    
    // Do payload (fallback)
    if (payload.appointmentId) return 'appointment';
    if (payload.leadId) return 'lead';
    if (payload.patientId) return 'patient';
    if (payload.paymentId) return 'payment';
    if (payload.invoiceId) return 'invoice';
    if (payload.packageId) return 'package';
    if (payload.followupId) return 'followup';
    
    return 'system';
}

/**
 * Extrai aggregate ID do payload
 */
function extractAggregateId(payload) {
    return payload.appointmentId || 
           payload.leadId || 
           payload.patientId ||
           payload.paymentId ||
           payload.invoiceId ||
           payload.packageId ||
           payload.followupId ||
           payload.sessionId ||
           payload.entityId ||
           'unknown';
}

/**
 * Gera idempotencyKey baseada no aggregate + ação
 * Formato: {aggregateType}_{aggregateId}_{action}
 * 
 * Exemplos:
 * - appointment_123_cancel
 * - appointment_456_complete
 * - payment_789_process
 */
function generateIdempotencyKey(eventType, payload, aggregateId) {
    const id = aggregateId || 
               payload.appointmentId || 
               payload.paymentId || 
               payload.sessionId ||
               payload.patientId ||
               'unknown';
    
    // Extrai ação do eventType
    const action = eventType.toLowerCase()
        .replace('appointment_', '')
        .replace('payment_', '')
        .replace('session_', '')
        .replace('_requested', '')
        .replace('_completed', '')
        .replace('_failed', '');
    
    return `${id}_${action}`;
}

/**
 * Publica múltiplos eventos
 * 
 * @param {Array} events - Array de { eventType, payload, options }
 * @returns {Array} Resultados
 */
export async function publishEvents(events) {
    const results = [];
    
    for (const { eventType, payload, options } of events) {
        try {
            const result = await publishEvent(eventType, payload, options);
            results.push({ success: true, ...result });
        } catch (error) {
            results.push({ success: false, error: error.message, eventType });
        }
    }
    
    return results;
}

/**
 * Fecha todas as conexões de fila
 */
export async function closeQueues() {
    for (const [name, queue] of Object.entries(queues)) {
        await queue.close();
        console.log(`[EventPublisher] Fila ${name} fechada`);
    }
}
