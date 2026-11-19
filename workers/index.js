// workers/index.js
// 🏗️ Entrypoint unificado — mantido para compatibilidade. Use registry.js para escala.

// registry.js NÃO é importado aqui no topo: alguns workers BullMQ são criados na
// importação do módulo (patientWorker, packageProjectionWorker, packageProcessingWorker,
// communicationEmailWorker). Um Worker criado com o Redis fora do ar (conexão lazy)
// morre com "Connection is closed." e NÃO volta a consumir quando o Redis volta, nem
// com worker.run() (reproduzido no isolado, item 7: tests/isolado/workersRedisVolta).
// Por isso o registry só é carregado depois que o Redis respondeu (loadRegistry).
import { redisConnection } from '../infrastructure/queue/queueConfig.js';

// Mesma lista de Object.keys(GROUPS) em registry.js (conferido ao carregar e em teste).
export const VALID_GROUPS = ['outbox', 'scheduling', 'billing', 'clinical', 'whatsapp', 'reconciliation'];

let registryPromise = null;
async function waitForRedis() {
    const t0 = Date.now();
    const warn = setInterval(() => console.warn(JSON.stringify({ msg: 'workers_waiting_redis', waitedMs: Date.now() - t0 })), 10_000);
    try {
        await redisConnection.ping(); // com o Redis fora, espera a reconexão (fila offline)
    } finally {
        clearInterval(warn);
    }
    if (Date.now() - t0 > 1000) console.log(JSON.stringify({ msg: 'workers_redis_ready_after_wait', waitedMs: Date.now() - t0 }));
}
export async function loadRegistry() {
    await waitForRedis();
    registryPromise ??= import('./registry.js').then((m) => {
        const real = [...m.VALID_GROUPS].sort().join(',');
        if (real !== [...VALID_GROUPS].sort().join(',')) {
            throw new Error(`VALID_GROUPS desatualizado em workers/index.js: registry tem ${real}`);
        }
        return m;
    });
    return registryPromise;
}

const WORKERS_STANDALONE_KEY = 'workers:standalone:active';
const WORKERS_EMBEDDED_KEY = 'workers:embedded:active';
const LOCK_TTL_SECONDS = 60;

const workers = [];

async function acquireWorkerLock(mode) {
    const key = mode === 'standalone' ? WORKERS_STANDALONE_KEY : WORKERS_EMBEDDED_KEY;
    const otherKey = mode === 'standalone' ? WORKERS_EMBEDDED_KEY : WORKERS_STANDALONE_KEY;

    // Verifica se o outro modo está ativo
    const otherActive = await redisConnection.get(otherKey);
    if (otherActive) {
        throw new Error(
            `🚫 MODO DUAL DETECTADO: ${otherKey} já está ativo. ` +
            `Não é permitido rodar workers ${mode} enquanto o outro modo está ativo. ` +
            `Desligue o outro modo antes de continuar.`
        );
    }

    // Adquire o lock para este modo
    await redisConnection.set(key, process.pid, 'EX', LOCK_TTL_SECONDS);

    // Heartbeat para renovar o lock
    const heartbeat = setInterval(async () => {
        try {
            await redisConnection.set(key, process.pid, 'EX', LOCK_TTL_SECONDS);
        } catch (err) {
            console.error(`[Workers] Falha no heartbeat do lock ${key}:`, err.message);
        }
    }, 30000);

    // Limpa no shutdown
    process.on('SIGTERM', () => clearInterval(heartbeat));
    process.on('SIGINT', () => clearInterval(heartbeat));
}

async function releaseWorkerLock(mode) {
    const key = mode === 'standalone' ? WORKERS_STANDALONE_KEY : WORKERS_EMBEDDED_KEY;
    try {
        await redisConnection.del(key);
    } catch (err) {
        // ignore
    }
}

export async function startAllWorkers() {
    await acquireWorkerLock('embedded');
    console.log('[Workers] Iniciando todos os workers (modo monolítico)…\n');
    const { startAllWorkerGroups } = await loadRegistry();
    await startAllWorkerGroups(workers);
    global.workersAtivos = true;
    console.log('\n[Workers] Todos os workers iniciados!\n');
    return workers;
}

export async function startWorkersByGroup(groupName) {
    await acquireWorkerLock('embedded');
    console.log(`[Workers] Iniciando grupo: ${groupName}\n`);
    const { startWorkerGroup } = await loadRegistry();
    await startWorkerGroup(groupName, workers);
    global.workersAtivos = true;
    console.log(`\n[Workers] Grupo ${groupName} iniciado!\n`);
    return workers;
}


export function stopAllWorkers() {
    console.log('[Workers] Parando workers...');

    for (const worker of workers) {
        try {
            worker.close();
        } catch (err) {
            // ignore
        }
    }

    workers.length = 0;
    releaseWorkerLock('embedded').catch(() => {});
    releaseWorkerLock('standalone').catch(() => {});

    console.log('[Workers] Todos os workers parados');
}

// ── Bootstrap quando executado diretamente (node workers/index.js) ──
if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        try {
            console.log('[Workers] Bootstrap standalone iniciado');
            const mongoose = (await import('mongoose')).default;
            const dotenv = (await import('dotenv')).default;
            dotenv.config();
            await import('../models/index.js');
            const { bootstrapEventContracts } = await import('../infrastructure/events/bootstrapContracts.js');
            bootstrapEventContracts();

            const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
            if (!MONGO_URI) {
                console.error('❌ MONGODB_URI não configurada');
                process.exit(1);
            }

            await mongoose.connect(MONGO_URI, {
                maxPoolSize: 10,
                minPoolSize: 2,
                serverSelectionTimeoutMS: 30000
            });
            console.log('✅ MongoDB conectado');

            await acquireWorkerLock('standalone');
            await startAllWorkers();
            console.log('🎉 Workers standalone prontos!');
        } catch (err) {
            console.error('❌ Erro fatal no bootstrap:', err.message);
            process.exit(1);
        }
    })();
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[Workers] SIGTERM recebido, parando...');
    stopAllWorkers();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[Workers] SIGINT recebido, parando...');
    stopAllWorkers();
    process.exit(0);
});
