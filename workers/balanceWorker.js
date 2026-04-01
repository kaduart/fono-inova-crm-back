// workers/balanceWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import PatientBalance from '../models/PatientBalance.js';
import Session from '../models/Session.js';

/**
 * Worker de Balance - Processa atualizações de saldo
 * 
 * Características:
 * - STATE GUARD: Verifica se sessão está completed antes de processar
 * - Idempotente (usa eventId)
 * - Retry automático
 * - DLQ em caso de falha permanente
 * - Atomic $inc (não read-modify-write)
 */

const processedEvents = new Map();
const EVENT_CACHE_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [eventId, timestamp] of processedEvents) {
        if (now - timestamp > EVENT_CACHE_TTL) {
            processedEvents.delete(eventId);
        }
    }
}, 60 * 60 * 1000);

export function startBalanceWorker() {
    const worker = new Worker('balance-update', async (job) => {
        const { eventId, eventType, correlationId, payload } = job.data;
        
        console.log(`[BalanceWorker] Processando ${eventId}`, {
            attempt: job.attemptsMade + 1
        });
        
        // 1. IDEMPOTÊNCIA
        if (processedEvents.has(eventId)) {
            console.log(`[BalanceWorker] Evento já processado: ${eventId}`);
            return { status: 'already_processed' };
        }
        
        // 2. STATE GUARD: Verifica se sessão está completed
        if (payload.sessionId) {
            const session = await Session.findById(payload.sessionId)
                .select('status')
                .lean();
            
            if (!session) {
                throw new Error(`Sessão ${payload.sessionId} não encontrada`);
            }
            
            if (session.status !== 'completed') {
                // Ainda não está pronto, faz retry
                throw new Error(`STATE_GUARD: Session ${payload.sessionId} status=${session.status}, esperado=completed`);
            }
            
            console.log(`[BalanceWorker] State guard OK: session.completed`);
        }
        
        try {
            const { patientId, amount, description, sessionId, appointmentId, registeredBy } = payload;
            
            // 3. ATUALIZAÇÃO ATÔMICA
            const result = await PatientBalance.updateOne(
                { patient: patientId },
                {
                    $inc: { 
                        currentBalance: amount,
                        totalDebited: amount > 0 ? amount : 0,
                        totalCredited: amount < 0 ? Math.abs(amount) : 0
                    },
                    $push: {
                        transactions: {
                            type: amount > 0 ? 'debit' : 'credit',
                            amount: Math.abs(amount),
                            description,
                            sessionId,
                            appointmentId,
                            registeredBy,
                            transactionDate: new Date()
                        }
                    },
                    $set: { lastTransactionAt: new Date() }
                },
                { upsert: true }
            );
            
            if (result.modifiedCount === 0 && result.upsertedCount === 0) {
                throw new Error('Nenhum documento atualizado');
            }
            
            processedEvents.set(eventId, Date.now());
            
            console.log(`[BalanceWorker] Sucesso: patient=${patientId}, amount=${amount}`);
            
            return {
                status: 'success',
                eventId,
                patientId,
                amount
            };
            
        } catch (error) {
            console.error(`[BalanceWorker] Erro:`, error.message);
            
            if (job.attemptsMade >= 4) {
                await moveToDLQ(job, error);
            }
            
            throw error;
        }
        
    }, {
        connection: redisConnection,
        concurrency: 5,
        limiter: { max: 10, duration: 1000 }
    });
    
    worker.on('completed', (job, result) => {
        console.log(`[BalanceWorker] Job ${job.id} completado:`, result.status);
    });
    
    worker.on('failed', (job, error) => {
        console.error(`[BalanceWorker] Job ${job?.id} falhou:`, error.message);
    });
    
    console.log('[BalanceWorker] Worker iniciado');
    return worker;
}
