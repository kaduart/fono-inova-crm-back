/**
 * 🔥 WATCHDOG VIA BULLMQ CRON
 * 
 * Versão para Render.com - usa BullMQ Repeatable Jobs
 * Se o worker restartar, os jobs cron continuam agendados
 * 
 * Uso: node infrastructure/workers/watchdogBullmq.js
 * Ou: import { startWatchdogWorker } from './watchdogBullmq.js'
 */

import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import EventStore from '../../models/EventStore.js';
import Appointment from '../../models/Appointment.js';
import { redisConnection, getQueue } from '../queue/queueConfig.js';
import { createContextLogger } from '../../utils/logger.js';

const log = createContextLogger('watchdog-bullmq', 'system');

// Configurações
const STUCK_THRESHOLD_MINUTES = 5;
const MAX_RETRY_COUNT = 3;  // 🛡️ Máximo de retries antes de ir para failed
const WATCHDOG_QUEUE = 'watchdog-tasks';
const WATCHDOG_JOB_NAME = 'check-stuck-events';

/**
 * Inicia watchdog usando BullMQ Repeatable Jobs
 */
export async function startWatchdogWorker() {
    console.log('[WatchdogBullmq] 🚀 Iniciando watchdog via BullMQ...');
    
    // Garante conexão MongoDB
    await ensureMongoConnection();
    
    // Cria queue para agendar jobs
    const queue = getQueue(WATCHDOG_QUEUE);
    
    // Remove jobs antigos e agenda novo
    await queue.obliterate({ force: true });
    
    // Agenda job para rodar a cada 60 segundos
    await queue.add(
        WATCHDOG_JOB_NAME,
        { type: 'stuck-events-check' },
        {
            repeat: {
                every: 60 * 1000, // 60 segundos
            },
            jobId: 'watchdog-recurring', // ID fixo para evitar duplicados
            removeOnComplete: 10,
            removeOnFail: 5
        }
    );
    
    console.log('[WatchdogBullmq] ✅ Job agendado a cada 60s');
    
    // Cria worker para processar
    const worker = new Worker(
        WATCHDOG_QUEUE,
        async (job) => {
            if (job.name === WATCHDOG_JOB_NAME) {
                return await checkAndRecoverStuckEvents();
            }
        },
        {
            connection: redisConnection,
            concurrency: 1,
            removeOnComplete: { count: 10 },
            removeOnFail: { count: 5 }
        }
    );
    
    worker.on('completed', (job, result) => {
        if (result?.recovered > 0) {
            console.log(`[WatchdogBullmq] ✅ Recuperados ${result.recovered} eventos`);
        }
    });
    
    worker.on('failed', (job, error) => {
        console.error('[WatchdogBullmq] ❌ Job falhou:', error.message);
    });
    
    console.log('[WatchdogBullmq] ✅ Worker iniciado');
    
    // Graceful shutdown
    process.on('SIGTERM', async () => {
        console.log('[WatchdogBullmq] 🛑 SIGTERM recebido, fechando...');
        await worker.close();
        await queue.close();
        process.exit(0);
    });
    
    return { worker, queue };
}

/**
 * Verifica e recupera eventos travados
 */
async function checkAndRecoverStuckEvents() {
    const startTime = Date.now();
    
    try {
        const minAgeMs = STUCK_THRESHOLD_MINUTES * 60 * 1000;
        const cutoffTime = new Date(Date.now() - minAgeMs);
        
        // Busca eventos travados
        const stuckEvents = await EventStore.find({
            status: 'processing',
            updatedAt: { $lt: cutoffTime }
        })
        .sort({ updatedAt: 1 })
        .limit(50);
        
        if (stuckEvents.length === 0) {
            return { status: 'clean', recovered: 0, duration: Date.now() - startTime };
        }
        
        console.log(`[WatchdogBullmq] Encontrados ${stuckEvents.length} eventos travados`);
        
        // Recupera cada evento
        const results = [];
        for (const event of stuckEvents) {
            const result = await recoverEvent(event);
            results.push(result);
        }
        
        const successCount = results.filter(r => r.success).length;
        
        return {
            status: 'recovered',
            recovered: successCount,
            failed: stuckEvents.length - successCount,
            duration: Date.now() - startTime
        };
        
    } catch (error) {
        console.error('[WatchdogBullmq] ❌ Erro:', error.message);
        throw error;
    }
}

async function recoverEvent(event) {
    const minutesStuck = Math.round((Date.now() - event.updatedAt.getTime()) / 60000);
    const retryCount = (event.recoveryHistory?.length || 0) + 1;
    
    console.log(`[WatchdogBullmq] Analisando evento ${event.eventId}`, {
        retryCount: retryCount,
        maxRetries: MAX_RETRY_COUNT
    });
    
    try {
        // 🛡️ PROTEÇÃO: Se excedeu max retries, marca como failed
        if (retryCount >= MAX_RETRY_COUNT) {
            console.error(`[WatchdogBullmq] 🔴 Evento ${event.eventId} excedeu ${MAX_RETRY_COUNT} retries → marcando como failed`);
            
            await EventStore.updateOne(
                { _id: event._id },
                {
                    $set: {
                        status: 'failed',
                        error: `MAX_RETRIES_EXCEEDED: ${MAX_RETRY_COUNT} tentativas falharam`,
                        failedAt: new Date(),
                        updatedAt: new Date()
                    },
                    $push: {
                        recoveryHistory: {
                            action: 'max_retries_exceeded',
                            retryCount: retryCount,
                            failedAt: new Date()
                        }
                    }
                }
            );
            
            if (event.aggregateType === 'appointment') {
                await releaseAppointmentLock(event.aggregateId, minutesStuck, true);
            }
            
            return { 
                eventId: event.eventId, 
                success: false, 
                reason: 'max_retries_exceeded',
                retryCount 
            };
        }
        
        // Reset para pending
        await EventStore.updateOne(
            { _id: event._id },
            {
                $set: {
                    status: 'pending',
                    updatedAt: new Date()
                },
                $push: {
                    recoveryHistory: {
                        action: 'auto_recover_bullmq',
                        previousStatus: 'processing',
                        stuckDurationMinutes: minutesStuck,
                        retryCount: retryCount,
                        recoveredAt: new Date()
                    }
                }
            }
        );
        
        // Libera lock do appointment
        if (event.aggregateType === 'appointment') {
            await releaseAppointmentLock(event.aggregateId, minutesStuck, false);
        }
        
        return { 
            eventId: event.eventId, 
            success: true, 
            retryCount,
            stuckMinutes: minutesStuck 
        };
        
    } catch (error) {
        return { eventId: event.eventId, success: false, error: error.message };
    }
}

async function releaseAppointmentLock(appointmentId, stuckMinutes, isMaxRetries = false) {
    try {
        const apt = await Appointment.findById(appointmentId);
        if (!apt || apt.operationalStatus !== 'processing_complete') return;
        
        const context = isMaxRetries
            ? `MAX RETRIES atingido - evento marcado como failed`
            : `Evento travado por ${stuckMinutes} min - BullMQ watchdog`;
            
        await Appointment.updateOne(
            { _id: appointmentId },
            {
                $set: {
                    operationalStatus: 'scheduled',
                    updatedAt: new Date()
                },
                $push: {
                    history: {
                        action: isMaxRetries ? 'auto_release_max_retries' : 'auto_release_watchdog_bullmq',
                        previousStatus: 'processing_complete',
                        newStatus: 'scheduled',
                        timestamp: new Date(),
                        context: context
                    }
                }
            }
        );
        console.log(`[WatchdogBullmq] 🔓 Appointment ${appointmentId} liberado${isMaxRetries ? ' (MAX RETRIES)' : ''}`);
    } catch (error) {
        console.error(`[WatchdogBullmq] Erro ao liberar lock:`, error.message);
    }
}

async function ensureMongoConnection() {
    if (mongoose.connection.readyState === 1) return;
    
    const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!MONGO_URI) throw new Error('MONGODB_URI não configurada');
    
    await mongoose.connect(MONGO_URI, {
        maxPoolSize: 5,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 30000
    });
    console.log('[WatchdogBullmq] 🟢 MongoDB conectado');
}

// Se rodar diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
    startWatchdogWorker().catch(err => {
        console.error('[WatchdogBullmq] ❌ Falha ao iniciar:', err);
        process.exit(1);
    });
}
