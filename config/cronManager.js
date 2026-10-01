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

/**
 * Inicia todos os crons críticos da aplicação.
 * Pode ser chamado tanto pelo server.js (modo monolítico legado)
 * quanto pelo cron-worker dedicado.
 */
export async function startAllCrons() {
    const { initAppointmentRecoveryCron } = await import("../crons/appointmentRecovery.cron.js");
    startCron('appointmentRecovery', () => initAppointmentRecoveryCron());

    const { initEventReaperCron } = await import("../crons/eventReaper.cron.js");
    startCron('eventReaper', () => initEventReaperCron());

    const { scheduleFinancialSnapshotAudit } = await import("../crons/financialSnapshotAudit.cron.js");
    startCron('financialSnapshotAudit', () => scheduleFinancialSnapshotAudit());

    // Detecta (não conserta) PackagesView divergente do domínio — ponto cego que
    // deixou cancelamentos sumirem da tela por meses. Ver incidente 2026-08-12.
    const { initPackageViewDriftCron } = await import("../crons/packageViewDriftCheck.cron.js");
    startCron('packageViewDrift', () => initPackageViewDriftCron());

    const { schedulePatientConsistency } = await import("../crons/patientConsistency.cron.js");
    startCron('patientConsistency', () => schedulePatientConsistency());

    const { schedulePreAgendamentoExpiration } = await import("../crons/preAgendamentoExpiration.cron.js");
    startCron('preAgendamentoExpiration', () => schedulePreAgendamentoExpiration());

    const { scheduleStateMachineConvenioReconciliation } = await import("../crons/stateMachineConvenioReconciliation.cron.js");
    startCron('stateMachineConvenioReconciliation', () => scheduleStateMachineConvenioReconciliation());

    const { initCommunicationReconciliationCron } = await import("../crons/communicationReconciliation.cron.js");
    startCron('communicationReconciliation', () => initCommunicationReconciliationCron());

    const { scheduleWorkerHours } = await import("../crons/workerScheduler.cron.js");
    startCron('workerScheduler', () => scheduleWorkerHours());

    // Despesas fixas: mantém o mês corrente sempre completo (idempotente, a cada 6h + catch-up no boot).
    // Roda no crm-backend, não no crm-worker — janela do ADR-022 não se aplica.
    const { scheduleFixedExpenseGeneration } = await import("../crons/fixedExpenseGeneration.cron.js");
    startCron('fixedExpenseGeneration', () => scheduleFixedExpenseGeneration());

    // Conversões offline (Meta CAPI + Google Ads) — desligado por padrão
    if (process.env.ENABLE_ADS_CONVERSION === 'true') {
        const { initAdsConversionCron } = await import("../crons/adsConversion.cron.js");
        startCron('adsConversion', () => initAdsConversionCron());
    }

    console.log("✅ Crons críticos habilitados (appointmentRecovery + eventReaper + financialSnapshotAudit + patientConsistency + preAgendamentoExpiration + stateMachineConvenioReconciliation + communicationReconciliation + workerScheduler + fixedExpenseGeneration)");
}

export default { startCron, stopCron, stopAllCrons, listActiveCrons, startAllCrons };
