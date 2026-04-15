/**
 * Worker: Complete Orchestrator (SECONDARY - v2.0)
 * 
 * 🔒 RESPONSABILIDADE REDUZIDA: Este worker NÃO é mais responsável pela
 * consistência primária do sistema. Ele processa apenas coisas SECUNDÁRIAS:
 * - Logs e analytics
 * - Notificações async
 * - Billing complementar (se necessário)
 * 
 * A consistência primária (Session, Appointment, Payment) agora é garantida
 * SINCRONAMENTE no endpoint PATCH /:id/complete.
 */

import { Worker } from 'bullmq';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import EventStore from '../models/EventStore.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

const WORKER_TIMEOUT_MS = 30000;
const MEMORY_THRESHOLD_PERCENT = 95;

// ============ MONITORAMENTO DE MEMÓRIA ============
function checkMemoryPressure() {
    const usage = process.memoryUsage();
    const heapPercent = Math.round((usage.heapUsed / usage.heapTotal) * 100);
    
    if (heapPercent > MEMORY_THRESHOLD_PERCENT) {
        console.error(`[MEMORY ALERT] Heap usage: ${heapPercent}% - Rejeitando job`);
        return { pressure: true, heapPercent };
    }
    return { pressure: false, heapPercent };
}

// ============ PROCESSAMENTO SECUNDÁRIO ============
async function processSecondaryTasks(jobData) {
    const { 
        appointmentId, 
        patientId, 
        doctorId, 
        sessionId, 
        packageId, 
        isPrepaid,
        addToBalance,
        userId,
        completedAt 
    } = jobData;

    console.log(`[WORKER] Processando tarefas secundárias para ${appointmentId}`);

    // 1. REGISTRAR EVENTO (para auditoria)
    try {
        await EventStore.create({
            type: EventTypes.APPOINTMENT_COMPLETED,
            status: 'processed',
            aggregateType: 'appointment',
            aggregateId: appointmentId,
            payload: jobData,
            processedAt: new Date()
        });
        console.log(`[WORKER] Evento registrado`);
    } catch (err) {
        console.error(`[WORKER] Erro ao registrar evento (não crítico):`, err.message);
    }

    // 2. ATUALIZAR ESTATÍSTICAS DO PACOTE (se aplicável)
    if (packageId && isPrepaid) {
        try {
            const pkg = await Package.findById(packageId);
            if (pkg) {
                // Recalcula sessões usadas
                const usedSessions = await mongoose.model('Session').countDocuments({
                    package: packageId,
                    status: 'completed'
                });
                
                pkg.sessionsUsed = usedSessions;
                pkg.remainingSessions = Math.max(0, pkg.totalSessions - usedSessions);
                
                if (pkg.remainingSessions === 0) {
                    pkg.status = 'completed';
                }
                
                await pkg.save();
                console.log(`[WORKER] Package ${packageId} atualizado: ${usedSessions}/${pkg.totalSessions} sessões`);
            }
        } catch (err) {
            console.error(`[WORKER] Erro ao atualizar package (não crítico):`, err.message);
        }
    }

    // 3. PUBLICAR EVENTO DE DOMÍNIO (para outros sistemas consumirem)
    try {
        await publishEvent(
            EventTypes.APPOINTMENT_COMPLETED_DOMAIN,
            {
                appointmentId,
                patientId,
                doctorId,
                sessionId,
                packageId,
                isPrepaid,
                addToBalance,
                completedAt: completedAt || new Date()
            },
            { correlationId: appointmentId }
        );
        console.log(`[WORKER] Evento de domínio publicado`);
    } catch (err) {
        console.error(`[WORKER] Erro ao publicar evento (não crítico):`, err.message);
    }

    console.log(`[WORKER] ✅ Tarefas secundárias concluídas para ${appointmentId}`);
    return { status: 'success', appointmentId };
}

// ============ WRAPPER COM TIMEOUT ============
async function processCompleteJob(jobData) {
    const { appointmentId } = jobData;
    
    // 🔧 MEMORY CHECK: Só loga warning, NUNCA rejeita job
    const memCheck = checkMemoryPressure();
    if (memCheck.pressure) {
        console.warn(`[WORKER] ⚠️ Memory pressure ${memCheck.heapPercent}%, mas processando mesmo assim`);
    }
    
    // Timeout de 30 segundos
    return Promise.race([
        processSecondaryTasks(jobData),
        new Promise((_, reject) => 
            setTimeout(() => {
                reject(new Error(`PROCESS_TIMEOUT: Job excedeu ${WORKER_TIMEOUT_MS}ms`));
            }, WORKER_TIMEOUT_MS)
        )
    ]);
}

// ============ INICIALIZAÇÃO DO WORKER ============
export function startCompleteOrchestratorWorker() {
    console.log('[WORKER] 🚀 Iniciando CompleteOrchestratorWorker (SECONDARY)...');
    console.log('[WORKER] 📍 Modo: Processamento secundário apenas (logs/analytics)');
    
    const worker = new Worker(
        'complete-orchestrator',
        async (job) => {
            const jobPayload = job.data.payload || job.data;
            console.log(`[WORKER] Job ${job.id}: ${job.name} | appointment: ${jobPayload?.appointmentId}`);
            return processCompleteJob(jobPayload);
        },
        {
            connection: redis,
            concurrency: 3,
            limiter: {
                max: 10,
                duration: 1000
            }
        }
    );
    
    worker.on('completed', (job, result) => {
        console.log(`[WORKER] Job ${job.id} completado:`, result?.status);
    });
    
    worker.on('failed', (job, err) => {
        console.error(`[WORKER] Job ${job?.id} falhou:`, err.message);
    });
    
    console.log('[WORKER] ✅ CompleteOrchestratorWorker iniciado (não crítico)');
    return worker;
}

export default startCompleteOrchestratorWorker;
