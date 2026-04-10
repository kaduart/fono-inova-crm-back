// config/cronManager.js
/**
 * Gerenciador Singleton de Crons
 * Garante que cada cron só seja iniciado uma vez
 */

const activeCrons = new Map();

export function startCron(name, startFn) {
    if (activeCrons.has(name)) {
        console.log(`[CronManager] ⚠️ Cron '${name}' já está rodando, ignorando duplicação`);
        return activeCrons.get(name);
    }
    
    console.log(`[CronManager] ✅ Iniciando cron: ${name}`);
    const cronInstance = startFn();
    activeCrons.set(name, cronInstance);
    return cronInstance;
}

export function stopCron(name) {
    if (activeCrons.has(name)) {
        const cron = activeCrons.get(name);
        if (cron && typeof cron.stop === 'function') {
            cron.stop();
        }
        activeCrons.delete(name);
        console.log(`[CronManager] 🛑 Cron '${name}' parado`);
    }
}

export function stopAllCrons() {
    console.log(`[CronManager] 🛑 Parando ${activeCrons.size} crons...`);
    activeCrons.forEach((cron, name) => {
        if (cron && typeof cron.stop === 'function') {
            cron.stop();
        }
    });
    activeCrons.clear();
}

export function listActiveCrons() {
    return Array.from(activeCrons.keys());
}

export default { startCron, stopCron, stopAllCrons, listActiveCrons };
