// infrastructure/outbox/outboxPattern.js
import mongoose from 'mongoose';
import { getQueue } from '../queue/queueConfig.js';

/**
 * OUTBOX PATTERN
 * 
 * Garante consistência entre banco de dados e fila de mensagens.
 * 
 * Problema: Se publicarmos evento diretamente após DB commit,
 * e o servidor crashar entre o commit e a publicação → evento perdido.
 * 
 * Solução: 
 * 1. Salvar evento na tabela Outbox (mesma transação do DB)
 * 2. Worker separado lê Outbox e publica para fila
 * 3. Marca como processado (ou remove)
 * 
 * Isso garante:
 * - Atomicidade: DB + Outbox na mesma transação
 * - Durabilidade: Evento só é removido após confirmação de publicação
 * - Recuperação: Se falhar, retry automático
 */

const outboxSchema = new mongoose.Schema({
    eventId: { type: String, required: true, index: true },
    correlationId: { type: String, required: true, index: true },
    eventType: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    aggregateType: { type: String, required: true },
    aggregateId: { type: String, required: true, index: true },
    status: {
        type: String,
        enum: ['pending', 'published', 'failed'],
        default: 'pending',
        index: true
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    scheduledAt: { type: Date, default: Date.now },
    publishedAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
});

outboxSchema.index({ status: 1, scheduledAt: 1 });
outboxSchema.index({ aggregateType: 1, aggregateId: 1 });

const Outbox = mongoose.models.Outbox || mongoose.model('Outbox', outboxSchema);

export async function saveToOutbox(event, session) {
    const outboxEntry = new Outbox({
        eventId: event.eventId,
        correlationId: event.correlationId,
        eventType: event.eventType,
        payload: event.payload,
        aggregateType: event.aggregateType || 'unknown',
        aggregateId: event.aggregateId || 'unknown',
        status: 'pending',
        createdAt: new Date()
    });
    
    await outboxEntry.save({ session });
    console.log(`[Outbox] Evento salvo: ${event.eventId} (${event.eventType})`);
    return outboxEntry;
}

export async function publishPendingEvents(batchSize = 100) {
    console.log('[Outbox] Verificando eventos pendentes...');
    
    // Verifica se mongoose está conectado
    if (mongoose.connection.readyState !== 1) {
        console.log('[Outbox] MongoDB não conectado, pulando...');
        return { processed: 0, published: 0, failed: 0, errors: [] };
    }
    
    const query = {
        status: 'pending',
        scheduledAt: { $lte: new Date() }
    };
    console.log('[Outbox] Query:', JSON.stringify(query));
    
    const pendingEvents = await Outbox.find(query)
    .sort({ createdAt: 1 })
    .limit(batchSize)
    .lean();
    
    console.log(`[Outbox] Encontrados ${pendingEvents.length} eventos pendentes`);
    
    const results = { processed: 0, published: 0, failed: 0, errors: [] };
    
    for (const event of pendingEvents) {
        console.log(`[Outbox] Processando evento: ${event.eventId} (${event.eventType})`);
        try {
            const queueName = getQueueNameForEvent(event.eventType);
            console.log(`[Outbox] Publicando para fila: ${queueName}`);
            const queue = getQueue(queueName);
            
            await queue.add(event.eventType, {
                eventId: event.eventId,
                eventType: event.eventType,
                correlationId: event.correlationId,
                payload: event.payload,
                outboxId: event._id
            }, { jobId: event.eventId });
            console.log(`[Outbox] Evento publicado na fila ${queueName}: ${event.eventId}`);
            
            await Outbox.findByIdAndUpdate(event._id, {
                status: 'published',
                publishedAt: new Date(),
                $inc: { attempts: 1 }
            });
            
            results.published++;
        } catch (error) {
            console.error(`[Outbox] Falha ao publicar ${event.eventId}:`, error.message);
            
            await Outbox.findByIdAndUpdate(event._id, {
                status: 'failed',
                lastError: error.message,
                $inc: { attempts: 1 },
                scheduledAt: new Date(Date.now() + Math.pow(2, event.attempts || 0) * 1000)
            });
            
            results.failed++;
            results.errors.push({ eventId: event.eventId, error: error.message });
        }
        results.processed++;
    }
    
    return results;
}

export function startOutboxWorker(intervalMs = 1000) {
    console.log(`[OutboxWorker] Iniciado (intervalo: ${intervalMs}ms)`);
    
    const intervalId = setInterval(async () => {
        try {
            await publishPendingEvents(100);
        } catch (error) {
            console.error('[OutboxWorker] Erro:', error.message);
        }
    }, intervalMs);
    
    return () => clearInterval(intervalId);
}

export async function cleanupOutbox(olderThanDays = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    
    const result = await Outbox.deleteMany({
        status: 'published',
        publishedAt: { $lt: cutoffDate }
    });
    
    console.log(`[Outbox] Cleanup: ${result.deletedCount} eventos removidos`);
    return result.deletedCount;
}

function getQueueNameForEvent(eventType) {
    const mapping = {
        // ✅ JÁ EXISTIAM
        'SESSION_COMPLETED': 'sync-medical',
        'BALANCE_UPDATE_REQUESTED': 'balance-update',
        'APPOINTMENT_COMPLETED': 'sync-medical',
        'APPOINTMENT_CANCELLED': 'sync-medical',
        'INVOICE_CREATED': 'notification',
        'INVOICE_PER_SESSION_CREATE': 'invoice-processing',
        
        // 🆕 NOVOS - Sincronizado com eventPublisher.js
        // Intenções → Workers de orquestração
        'APPOINTMENT_CREATE_REQUESTED': 'appointment-processing',
        'APPOINTMENT_CANCEL_REQUESTED': 'cancel-orchestrator',
        'APPOINTMENT_COMPLETE_REQUESTED': 'complete-orchestrator',
        'APPOINTMENT_UPDATE_REQUESTED': 'update-orchestrator',
        'PAYMENT_REQUESTED': 'payment-processing',
        'PAYMENT_PROCESS_REQUESTED': 'payment-processing',
        'PAYMENT_UPDATE_REQUESTED': 'payment-processing',
        
        // Resultados → Workers de reação
        'APPOINTMENT_CREATED': 'notification',
        'APPOINTMENT_CANCELED': 'sync-medical',
        'APPOINTMENT_REJECTED': 'notification',
        
        // Sessions
        'SESSION_CANCELED': 'sync-medical',
        
        // Payments
        'PAYMENT_COMPLETED': 'notification',
        'PAYMENT_FAILED': 'notification',
        
        // Packages
        'PACKAGE_CREDIT_CONSUMED': 'package-validation',
        'PACKAGE_NO_CREDIT': 'notification',
        
        // Insurance
        'INSURANCE_GUIDE_CONSUMED': 'sync-medical',
        'LIMINAR_REVENUE_RECOGNIZED': 'sync-medical',
        
        // Sync
        'SYNC_MEDICAL_EVENT': 'sync-medical',
        'NOTIFICATION_REQUESTED': 'notification',
        
        // Faturas
        'INVOICE_PAID': 'notification',
        'INVOICE_OVERDUE': 'notification',
        'INVOICE_CANCELED': 'notification',
        
        // Lotes
        'INSURANCE_BATCH_SENT': 'sync-medical',
        'INSURANCE_BATCH_RECEIVED': 'sync-medical',
        'INSURANCE_GLOSA': 'sync-medical',
        
        // Leads → Lead Processing
        'LEAD_CREATED': 'lead-processing',
        'LEAD_UPDATED': 'lead-processing',
        'LEAD_CONVERTED': 'lead-processing',
        
        // Followups
        'FOLLOWUP_REQUESTED': 'followup-processing',
        'FOLLOWUP_SCHEDULED': 'followup-processing',
        'FOLLOWUP_SENT': 'notification',
        'FOLLOWUP_FAILED': 'notification',
        
        // Notificações
        'NOTIFICATION_SENT': 'notification',
        'NOTIFICATION_FAILED': 'notification',
        'NOTIFICATION_DELIVERED': 'notification',
        
        // Canais específicos
        'WHATSAPP_MESSAGE_REQUESTED': 'whatsapp-notification',
        'WHATSAPP_MESSAGE_SENT': 'notification',
        'WHATSAPP_MESSAGE_FAILED': 'notification',
        'EMAIL_MESSAGE_REQUESTED': 'email-notification',
        'EMAIL_MESSAGE_SENT': 'notification',
        'EMAIL_MESSAGE_FAILED': 'notification',
        'SMS_MESSAGE_REQUESTED': 'notification'
    };
    
    const queueName = mapping[eventType];
    if (!queueName) {
        console.warn(`[Outbox] Evento não mapeado: ${eventType} - caindo em fila 'default'`);
    }
    return queueName || 'default';
}

export { Outbox };
