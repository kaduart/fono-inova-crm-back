// workers/index.js
// 🏗️ Entrypoint unificado — mantido para compatibilidade. Use registry.js para escala.

import { startAllWorkerGroups, startWorkerGroup, VALID_GROUPS } from './registry.js';

const workers = [];

export async function startAllWorkers() {
    console.log('[Workers] Iniciando todos os workers (modo monolítico)…\n');
    await startAllWorkerGroups(workers);
    global.workersAtivos = true;
    console.log('\n[Workers] Todos os workers iniciados!\n');
    return workers;
}

export async function startWorkersByGroup(groupName) {
    console.log(`[Workers] Iniciando grupo: ${groupName}\n`);
    await startWorkerGroup(groupName, workers);
    global.workersAtivos = true;
    console.log(`\n[Workers] Grupo ${groupName} iniciado!\n`);
    return workers;
}

export { VALID_GROUPS };

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
