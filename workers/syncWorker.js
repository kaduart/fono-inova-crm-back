// workers/syncWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { syncEvent } from '../services/syncService.js';

/**
 * Worker de Sync - Processa sincronização com MedicalEvent
 * 
 * Menor prioridade, pode falhar silenciosamente
 */

export function startSyncWorker() {
    const worker = new Worker('event-sync', async (job) => {
        const { eventId, eventType, correlationId, payload } = job.data;
        
        console.log(`[SyncWorker] Processando ${eventType}`, { eventId, correlationId });
        
        try {
            const { appointmentId, sessionId, action } = payload;
            
            if (action === 'SESSION_COMPLETED') {
                // Busca dados atualizados
                const Appointment = (await import('../models/Appointment.js')).default;
                
                const appointment = await Appointment.findById(appointmentId)
                    .populate('session patient doctor')
                    .lean();
                
                if (appointment) {
                    await syncEvent(appointment, 'appointment');
                    console.log(`[SyncWorker] Appointment ${appointmentId} sincronizado`);
                }
                
                if (sessionId) {
                    const Session = (await import('../models/Session.js')).default;
                    const session = await Session.findById(sessionId).lean();
                    
                    if (session) {
                        await syncEvent(session, 'session');
                        console.log(`[SyncWorker] Session ${sessionId} sincronizada`);
                    }
                }
            }
            
            return { status: 'synced', eventId };
            
        } catch (error) {
            console.error(`[SyncWorker] Erro (não crítico):`, error.message);
            
            // Sync não é crítico, mas move para DLQ após várias tentativas
            if (job.attemptsMade >= 2) {
                console.warn(`[SyncWorker] Falha após retries, ignorando`);
                return { status: 'failed_ignored', eventId, error: error.message };
            }
            
            throw error;
        }
        
    }, {
        connection: redisConnection,
        concurrency: 2,
        limiter: {
            max: 5,
            duration: 1000
        }
    });
    
    console.log('[SyncWorker] Worker iniciado');
    return worker;
}
