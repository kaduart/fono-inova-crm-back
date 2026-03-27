// infrastructure/queue/queueConfig.js
import { Queue } from 'bullmq';
import Redis from 'ioredis';

// Configuração de conexão Redis
const redisConnection = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

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
    'dlq': {
        defaultJobOptions: {
            removeOnComplete: false,
            removeOnFail: false
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
