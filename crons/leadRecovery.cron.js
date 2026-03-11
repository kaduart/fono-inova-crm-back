// crons/leadRecovery.cron.js
// Cron job para Lead Recovery - roda a cada 30 minutos
// Recupera leads que não agendaram após 6h e 24h

import cron from 'node-cron';
import { processRecoveryQueue, enableRecoveryForExistingLeads } from '../services/leadRecoveryService.js';

let isRunning = false;

/**
 * Inicializa o cron de Lead Recovery
 * Deve ser chamado no startup do servidor
 */
export function initLeadRecoveryCron() {
  console.log('🔁 Inicializando Lead Recovery Cron...');

  // Roda a cada 30 minutos
  // Formato: minuto hora dia-mês mês dia-semana
  cron.schedule('*/30 * * * *', async () => {
    if (isRunning) {
      console.log('⏭️ Lead Recovery já está rodando, pulando...');
      return;
    }

    isRunning = true;
    console.log(`🔁 [${new Date().toISOString()}] Executando Lead Recovery...`);

    try {
      const result = await processRecoveryQueue();

      if (result.processed > 0) {
        console.log(`✅ Lead Recovery: ${result.successful}/${result.processed} mensagens enviadas`);
      } else {
        console.log('📭 Lead Recovery: nenhum lead na fila');
      }
    } catch (error) {
      console.error('❌ Erro no Lead Recovery Cron:', error);
    } finally {
      isRunning = false;
    }
  }, {
    timezone: 'America/Sao_Paulo'
  });

  // Primeira execução após 2 minutos do startup (para não conflitar com outras inicializações)
  setTimeout(async () => {
    console.log('🚀 Primeira execução do Lead Recovery (warmup)...');
    try {
      // Opcional: ativar recovery para leads recentes que ainda não têm
      await enableRecoveryForExistingLeads(48);
    } catch (e) {
      console.error('Erro no warmup:', e);
    }
  }, 2 * 60 * 1000);

  console.log('✅ Lead Recovery Cron inicializado (a cada 30 min)');
}

export default { initLeadRecoveryCron };
