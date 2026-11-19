// infrastructure/queue/queueConfig.js
import { Queue } from 'bullmq';
import { redisConnection as sharedRedisConnection } from '../../config/redisConnection.js';

// ✅ REUTILIZA conexão Redis existente para evitar duplicação de conexões
const redisConnection = sharedRedisConnection;
console.log('[QueueConfig] Reutilizando conexão Redis existente');

// Configurações padrão de retry
export const defaultRetryConfig = {
    attempts: 5,
    backoff: {
        type: 'exponential',
        delay: 2000 // 2s, 4s, 8s, 16s, 32s
    }
};

// Configurações por fila
export const queueConfigs = {
    'session-completed': {
        ...defaultRetryConfig,
        defaultJobOptions: {
            removeOnComplete: 100,
            removeOnFail: 50
        }
    },
    'balance-update': {
        ...defaultRetryConfig,
        defaultJobOptions: {
            removeOnComplete: 200,
            removeOnFail: 100
        }
    },
    'payment-processing': {
        ...defaultRetryConfig,
        defaultJobOptions: {
            removeOnComplete: 100,
            removeOnFail: 50
        }
    },
    'event-sync': {
        attempts: 3,
        backoff: { type: 'fixed', delay: 5000 },
        defaultJobOptions: {
            removeOnComplete: 50,
            removeOnFail: 20
        }
    },
    'communication-email': {
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
        defaultJobOptions: {
            removeOnComplete: 100,
            removeOnFail: 50
        }
    },
    'dlq': {
        defaultJobOptions: {
            removeOnComplete: false,
            removeOnFail: false
        }
    },
    'planning-refresh': {
        ...defaultRetryConfig,
        defaultJobOptions: {
            removeOnComplete: 100,
            removeOnFail: 50
        }
    }
};

// Factory de filas
const queues = new Map();

export function getQueue(name) {
    if (!queues.has(name)) {
        const config = queueConfigs[name] || defaultRetryConfig;
        const queue = new Queue(name, {
            connection: redisConnection,
            ...config
        });
        
        queue.on('error', (error) => {
            console.error(`[Queue:${name}] Erro:`, error.message);
        });
        
        queues.set(name, queue);
        console.log(`[Queue:${name}] Inicializada`);
    }
    return queues.get(name);
}

/**
 * "Connection is closed." numa fila = o objeto Queue ficou inutilizável.
 * Acontece quando a fila é criada no primeiro uso do Redis (lazyConnect) com o
 * Redis fora do ar: a conexão compartilhada volta, mas essa Queue continua
 * recusando tudo até o processo reiniciar (reproduzido no ambiente integrado,
 * item 7). Filas criadas depois funcionam.
 */
export function isClosedConnectionError(err) {
    return /Connection is closed/i.test(String(err?.message || err || ''));
}

/**
 * Tira a fila do cache; o próximo getQueue(name) cria outra. Não fecha a conexão
 * compartilhada (a Queue foi criada com uma instância IORedis existente).
 * @returns {boolean} true se havia fila em cache.
 */
export function evictQueue(name) {
    const q = queues.get(name);
    if (!q) return false;
    queues.delete(name);
    Promise.resolve().then(() => q.close()).catch(() => {});
    console.warn(JSON.stringify({ msg: 'queue_evicted_closed_connection', queue: name }));
    return true;
}

// Graceful shutdown
export async function closeQueues() {
    console.log('[Queue] Fechando todas as filas...');
    for (const [name, queue] of queues) {
        await queue.close();
        console.log(`[Queue:${name}] Fechada`);
    }
    await redisConnection.quit();
}

export { redisConnection };

// DLQ helper function
const dlqQueues = new Map();

export async function moveToDLQ(job, error, queueName = 'dlq') {
    const dlq = getQueue(queueName);
    
    await dlq.add('failed-job', {
        originalJob: job.data,
        originalQueue: job.queueName,
        error: {
            message: error.message,
            stack: error.stack,
            name: error.name
        },
        failedAt: new Date().toISOString(),
        attempts: job.attemptsMade
    }, {
        jobId: `dlq_${job.id}_${Date.now()}`,
        priority: 1
    });
    
    console.log(`[DLQ] Job ${job.id} movido para ${queueName}`);
}
