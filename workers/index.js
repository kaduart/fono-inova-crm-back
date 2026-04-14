// workers/index.js
// 🏗️ Entrypoint unificado — mantido para compatibilidade. Use registry.js para escala.

import { startAllWorkerGroups, startWorkerGroup, VALID_GROUPS } from './registry.js';

const workers = [];

export async function startAllWorkers() {
    console.log('[Workers] Iniciando todos os workers (modo monolítico)…\n');
    await startAllWorkerGroups(workers);
    console.log('\n[Workers] Todos os workers iniciados!\n');
    return workers;
}

export async function startWorkersByGroup(groupName) {
    console.log(`[Workers] Iniciando grupo: ${groupName}\n`);
    await startWorkerGroup(groupName, workers);
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
