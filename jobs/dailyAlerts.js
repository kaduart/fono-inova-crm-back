// backend/jobs/dailyAlerts.js
import cron from 'node-cron';
import analytics from '../services/financial/financialAnalytics.service.js';

/**
 * Agenda o job de alertas diários para rodar às 9h da manhã.
 */
export const scheduleDailyAlerts = () => {
    // Roda todo dia às 09:00
    cron.schedule('0 9 * * *', async () => {
        console.log('[Cron] 🕒 Iniciando verificação de alertas de retenção financeira...');

        try {
            const { packagesEnding, churnRisk } = await analytics.getAlertsForToday();

            console.log(`[Cron] 📊 Resultados de hoje: ${packagesEnding.length} pacotes acabando, ${churnRisk.length} riscos de churn.`);

            // Log dos alertas encontrados para auditoria manual por enquanto
            packagesEnding.forEach(alert => {
                console.log(`[Alerta Retenção] PACIENTE: ${alert.patientName} | AÇÃO: Renovar pacote (${alert.remainingSessions} restam)`);
            });

            churnRisk.forEach(alert => {
                console.log(`[Alerta Retenção] PACIENTE: ${alert.patientName} | AÇÃO: Recuperar (Inativo desde ${alert.lastVisit})`);
            });

            // TODO: Integrar com amandaService.sendMessage quando o workflow de WhatsApp estiver validado

            console.log('[Cron] ✅ Verificação de alertas concluída.');
        } catch (error) {
            console.error('[Cron] ❌ Erro ao processar alertas diários:', error);
        }
    });

    console.log('⏰ Job de Alertas Diários agendado (09:00).');
};
