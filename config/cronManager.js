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

    // Expiração automática pre_agendado → missed: DESLIGADA de propósito (2026-10-28).
    // Plano de convênio com início retroativo nasce pré-agendado no passado e o cron marcava
    // tudo como falta (auto_expired) — falta ocupa vaga da guia, então "Gerar" não repunha
    // e sessões que aconteceram ficavam como falta (caso Linda Ayla, guia 16510723).
    // Falta agora só por ação humana. Para religar, descomente as 2 linhas.
    // const { schedulePreAgendamentoExpiration } = await import("../crons/preAgendamentoExpiration.cron.js");
    // startCron('preAgendamentoExpiration', () => schedulePreAgendamentoExpiration());

    const { scheduleStateMachineConvenioReconciliation } = await import("../crons/stateMachineConvenioReconciliation.cron.js");
    startCron('stateMachineConvenioReconciliation', () => scheduleStateMachineConvenioReconciliation());

    // Parabéns de aniversário às 10h (WhatsApp): cron PRONTO, mas DESLIGADO de propósito —
    // 1ª fase é só manual (botão no dashboard). Para ligar o automático, descomente as 2 linhas.
    // Idempotente: 1 envio por paciente por ano, então liga sem risco de duplicar com o manual.
    // const { scheduleBirthdayMessages } = await import("../crons/birthdayMessage.cron.js");
    // startCron('birthdayMessage', () => scheduleBirthdayMessages());

    const { initCommunicationReconciliationCron } = await import("../crons/communicationReconciliation.cron.js");
    startCron('communicationReconciliation', () => initCommunicationReconciliationCron());

    const { scheduleWorkerHours } = await import("../crons/workerScheduler.cron.js");
    startCron('workerScheduler', () => scheduleWorkerHours());

    // Despesas fixas: mantém o mês corrente sempre completo (idempotente, a cada 6h + catch-up no boot).
    // Roda no crm-backend, não no crm-worker — janela do ADR-022 não se aplica.
    const { scheduleFixedExpenseGeneration } = await import("../crons/fixedExpenseGeneration.cron.js");
    startCron('fixedExpenseGeneration', () => scheduleFixedExpenseGeneration());

    // OpenAI: API server-side, only the explicitly authorized minimal event.
    if (process.env.OPENAI_ADS_CONVERSIONS_API_KEY?.trim()) {
        const { initOpenAIAdsConversionCron } = await import("../crons/openaiAdsConversion.cron.js");
        startCron('openaiAdsConversion', () => initOpenAIAdsConversionCron());
    }

    // Conversões offline (Meta CAPI + Google Ads + TikTok) — liga quando há credencial de envio
    if (process.env.TIKTOK_EVENTS_TOKEN?.trim() || process.env.META_CONVERSIONS_TOKEN?.trim()) {
        const { initAdsConversionCron } = await import("../crons/adsConversion.cron.js");
        startCron('adsConversion', () => initAdsConversionCron());
    }

    console.log("✅ Crons críticos habilitados (appointmentRecovery + eventReaper + financialSnapshotAudit + patientConsistency + stateMachineConvenioReconciliation + communicationReconciliation + workerScheduler + fixedExpenseGeneration)");
}

export default { startCron, stopCron, stopAllCrons, listActiveCrons, startAllCrons };
