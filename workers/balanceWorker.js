// workers/balanceWorker.js
import { Worker, Queue } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import PatientBalance from '../models/PatientBalance.js';
import Session from '../models/Session.js';

const patientProjectionQueue = new Queue('patient-projection', { connection: redisConnection });

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
        
        console.log(`[BalanceWorker] Processando ${eventType}: ${eventId}`, {
            attempt: job.attemptsMade + 1
        });
        
        // IDEMPOTÊNCIA
        if (processedEvents.has(eventId)) {
            console.log(`[BalanceWorker] Evento já processado: ${eventId}`);
            return { status: 'already_processed' };
        }
        
        try {
            let result;
            
            switch (eventType) {
                case 'BALANCE_DEBIT_REQUESTED':
                    result = await handleDebit(payload, eventId);
                    break;
                default:
                    result = await handleLegacy(payload, eventId);
            }
            
            processedEvents.set(eventId, Date.now());
            return result;
            
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

async function handleDebit(payload, eventId) {
    const { patientId, amount, description, sessionId, appointmentId, requestedBy } = payload;
    
    if (sessionId) {
        const session = await Session.findById(sessionId).select('status').lean();
        if (session && session.status !== 'completed') {
            throw new Error(`STATE_GUARD: Session ${sessionId} status=${session.status}`);
        }
    }
    
    await PatientBalance.updateOne(
        { patient: patientId },
        {
            $inc: { 
                currentBalance: amount,
                totalDebited: amount
            },
            $push: {
                transactions: {
                    type: 'debit',
                    amount: Math.abs(amount),
                    description,
                    sessionId,
                    appointmentId,
                    registeredBy: requestedBy,
                    transactionDate: new Date()
                }
            },
            $set: { lastTransactionAt: new Date() }
        },
        { upsert: true }
    );
    
    console.log(`[BalanceWorker] Débito: patient=${patientId}, amount=${amount}`);

    await patientProjectionQueue.add('rebuild', {
        eventType: 'BALANCE_UPDATED',
        payload: { patientId },
        correlationId: eventId
    });

    return { status: 'success', eventId, patientId, amount };
}

async function handleLegacy(payload, eventId) {
    const { patientId, amount, description, sessionId, appointmentId, registeredBy } = payload;

    await PatientBalance.updateOne(
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

    await patientProjectionQueue.add('rebuild', {
        eventType: 'BALANCE_UPDATED',
        payload: { patientId },
        correlationId: eventId
    });

    return { status: 'success', eventId, patientId, amount };
}
