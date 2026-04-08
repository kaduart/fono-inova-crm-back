// workers/cancelOrchestratorWorker.js
// 🚀 VERSÃO PRODUÇÃO - Robusta, com retry, liberação de lock e garantias

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import { cancelSession } from '../domain/session/cancelSession.js';
import { cancelPayment } from '../domain/payment/cancelPayment.js';
import { restorePackageOnCancel } from '../domain/package/restorePackageOnCancel.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import mongoose from 'mongoose';
import { 
    eventExists, 
    processWithGuarantees, 
    appendEvent 
} from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';
import { createContextLogger } from '../utils/logger.js';

// 🔴 GARANTE CONEXÃO MONGO NO WORKER
let mongoConnected = false;
async function ensureMongoConnection() {
    if (mongoConnected && mongoose.connection.readyState === 1) {
        return;
    }
    
    const MONGO_URI = process.env.MONGO_URI;
    if (!MONGO_URI) {
        throw new Error('MONGO_URI não configurada');
    }
    
    try {
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000,
            socketTimeoutMS: 45000,
        });
        mongoConnected = true;
        console.log('[CancelOrchestrator] 🟢 MongoDB conectado');
    } catch (err) {
        console.error('[CancelOrchestrator] ❌ Falha ao conectar MongoDB:', err.message);
        throw err;
    }
}

// 🔴 LIBERA APPOINTMENT EM CASO DE FALHA
async function releaseAppointmentLock(appointmentId, reason = 'worker_failed') {
    if (!appointmentId) return;
    
    try {
        await ensureMongoConnection();
        
        const appointment = await Appointment.findById(appointmentId);
        if (!appointment) {
            console.log(`[CancelOrchestrator] ⚠️ Appointment não encontrado para liberar: ${appointmentId}`);
            return;
        }
        
        // Só libera se estiver em estado de processamento
        const processingStatuses = ['processing_cancel', 'processing_complete', 'processing_create'];
        if (!processingStatuses.includes(appointment.operationalStatus)) {
            console.log(`[CancelOrchestrator] ℹ️ Appointment não está em processamento: ${appointment.operationalStatus}`);
            return;
        }
        
        const previousStatus = appointment.operationalStatus === 'processing_create' ? 'pending' : 'scheduled';
        
        await Appointment.findByIdAndUpdate(appointmentId, {
            $set: { 
                operationalStatus: previousStatus,
                updatedAt: new Date()
            },
            $push: {
                history: {
                    action: 'auto_release_cancel',
                    previousStatus: appointment.operationalStatus,
                    newStatus: previousStatus,
                    timestamp: new Date(),
                    context: `Worker cancel falhou: ${reason}`
                }
            }
        });
        
        console.log(`[CancelOrchestrator] 🔓 Lock liberado: ${appointmentId} → ${previousStatus}`);
    } catch (err) {
        console.error(`[CancelOrchestrator] ❌ ERRO CRÍTICO ao liberar lock:`, err.message);
    }
}

/**
 * Cancel Orchestrator Worker - VERSÃO PRODUÇÃO
 */
export async function startCancelOrchestratorWorker() {
    console.log('[CancelOrchestrator] 🚀 Iniciando worker...');
    
    // Garante conexão antes de criar o worker
    await ensureMongoConnection();
    
    const worker = new Worker('cancel-orchestrator', async (job) => {
        const { eventId, correlationId, idempotencyKey, payload } = job.data;
        const { appointmentId, reason, confirmedAbsence, userId, forceCancel = false } = payload;
        
        // Garante conexão a cada job
        await ensureMongoConnection();
        
        console.log(`[CancelOrchestrator] Job ${job.id} - appointmentId: ${appointmentId}, tentativa ${job.attemptsMade + 1}`);
        
        const log = createContextLogger(correlationId || appointmentId, 'cancel');
        
        try {
            return await processCancelJob({
                job,
                eventId,
                correlationId,
                idempotencyKey,
                payload: { appointmentId, reason, confirmedAbsence, userId, forceCancel },
                log
            });
        } catch (error) {
            console.error(`[CancelOrchestrator] Job ${job.id} erro:`, error.message);
            
            // 🔴 LIBERA LOCK EM CASO DE ERRO
            await releaseAppointmentLock(appointmentId, error.message);
            
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 3,
        // 🔴 RETRY AUTOMÁTICO
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000
            },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 }
        }
    });
    
    // 🔴 HANDLER DE FALHA - LIBERA LOCK
    worker.on('failed', async (job, error) => {
        const appointmentId = job?.data?.payload?.appointmentId;
        console.error(`[CancelOrchestrator] Job ${job?.id} falhou após ${job?.attemptsMade} tentativas:`, error.message);
        
        if (job?.attemptsMade >= (job?.opts?.attempts || 1)) {
            await releaseAppointmentLock(appointmentId, `all_attempts_failed: ${error.message}`);
            
            try {
                await moveToDLQ('cancel-orchestrator', job, error);
            } catch (dlqErr) {
                console.error('[CancelOrchestrator] Erro ao mover para DLQ:', dlqErr.message);
            }
        }
    });
    
    worker.on('completed', (job, result) => {
        console.log(`[CancelOrchestrator] Job ${job.id} completado: ${result.status}`);
    });
    
    worker.on('error', (error) => {
        console.error('[CancelOrchestrator] Worker error:', error.message);
    });
    
    console.log('[CancelOrchestrator] ✅ Worker iniciado (v2.0 - Produção)');
    return worker;
}

async function processCancelJob({ job, eventId, correlationId, idempotencyKey, payload, log }) {
    const { appointmentId, reason, confirmedAbsence, userId, forceCancel } = payload;
    
    // 🛡️ IDEMPOTÊNCIA VIA EVENT STORE
    const existingEvent = await EventStore.findOne({ eventId });
    if (existingEvent) {
        if (existingEvent.status === 'processed') {
            log.info('idempotent', 'Evento já processado', { eventId });
            return { 
                status: 'already_processed', 
                appointmentId,
                eventId,
                idempotent: true
            };
        }
        if (existingEvent.status === 'processing') {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            if (existingEvent.updatedAt < fiveMinutesAgo) {
                log.warn('stale_processing', 'Evento travado em processing, reprocessando', { eventId });
            } else {
                log.info('concurrent', 'Evento em processamento por outro worker', { eventId });
                return { 
                    status: 'concurrent_processing', 
                    appointmentId,
                    eventId,
                    idempotent: true
                };
            }
        }
    }

    // 🛡️ IDEMPOTÊNCIA GLOBAL
    if (idempotencyKey && await eventExists(idempotencyKey)) {
        const existingByKey = await EventStore.findOne({ idempotencyKey });
        if (existingByKey?.status === 'processed') {
            log.info('idempotent', 'IdempotencyKey já processada', { idempotencyKey });
            return { 
                status: 'already_processed', 
                appointmentId,
                idempotent: true
            };
        }
    }

    // Cria/registra evento
    const storedEvent = await appendEvent({
        eventId,
        eventType: EventTypes.APPOINTMENT_CANCEL_REQUESTED,
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        payload,
        metadata: { correlationId, idempotencyKey, source: 'cancelOrchestratorWorker' },
        idempotencyKey: idempotencyKey || `cancel_${appointmentId}_${Date.now()}`
    });

    return await processWithGuarantees(storedEvent.eventId, async () => {
        const mongoSession = await mongoose.startSession();

        try {
            await mongoSession.startTransaction({
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' }
            });

            // 1. Busca appointment
            const appointment = await Appointment.findById(appointmentId).session(mongoSession);
            
            if (!appointment) {
                throw new Error('APPOINTMENT_NOT_FOUND');
            }

            // Guard: já cancelado
            if (appointment.operationalStatus === 'canceled') {
                return { 
                    status: 'already_canceled', 
                    appointmentId,
                    idempotent: true 
                };
            }

            const sessionId = appointment.session;
            const packageId = appointment.package;

            // 2. Cancela sessão (dentro da transação)
            if (sessionId) {
                try {
                    await cancelSession(sessionId, { 
                        mongoSession,
                        reason,
                        confirmedAbsence 
                    });
                } catch (sessionErr) {
                    console.warn('[CancelOrchestrator] ⚠️ Erro ao cancelar sessão:', sessionErr.message);
                    // Não falha o cancelamento se a sessão já estiver cancelada
                }
            }

            // 3. Restaura pacote (dentro da transação)
            if (packageId && !confirmedAbsence) {
                try {
                    await restorePackageOnCancel(packageId, { mongoSession });
                } catch (packageErr) {
                    console.warn('[CancelOrchestrator] ⚠️ Erro ao restaurar pacote:', packageErr.message);
                }
            }

            // 4. Cancela payment (dentro da transação)
            if (appointment.payment) {
                try {
                    await cancelPayment(appointment.payment, { mongoSession });
                } catch (paymentErr) {
                    console.warn('[CancelOrchestrator] ⚠️ Erro ao cancelar payment:', paymentErr.message);
                }
            }

            // 5. Atualiza appointment
            await Appointment.findByIdAndUpdate(
                appointmentId,
                {
                    $set: {
                        operationalStatus: 'canceled',
                        canceledReason: reason,
                        confirmedAbsence: confirmedAbsence || false,
                        canceledAt: new Date(),
                        updatedAt: new Date()
                    },
                    $push: {
                        history: {
                            action: 'canceled',
                            newStatus: 'canceled',
                            changedBy: userId,
                            timestamp: new Date(),
                            context: `Motivo: ${reason}${confirmedAbsence ? ' (Falta confirmada)' : ''}`
                        }
                    }
                },
                { session: mongoSession }
            );

            await mongoSession.commitTransaction();
            console.log('[CancelOrchestrator] ✅ Transação commitada');

        } catch (error) {
            console.error('[CancelOrchestrator] ❌ ERRO na transação:', error.message);
            await mongoSession.abortTransaction();
            throw error;
        } finally {
            mongoSession.endSession();
        }

        // PÓS-COMMIT: Eventos (não crítico)
        try {
            await publishEvent(
                EventTypes.APPOINTMENT_CANCELED,
                {
                    appointmentId: appointmentId.toString(),
                    patientId: appointment.patient?.toString(),
                    packageId: appointment.package?.toString(),
                    reason,
                    confirmedAbsence
                },
                { correlationId }
            );
        } catch (evtErr) {
            console.warn('[CancelOrchestrator] ⚠️ Erro ao publicar evento:', evtErr.message);
        }

        return {
            status: 'canceled',
            appointmentId,
            idempotent: false
        };
    });
}
