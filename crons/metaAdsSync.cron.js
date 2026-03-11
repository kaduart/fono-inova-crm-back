/**
 * ⏰ Meta Ads Sync Cron Job
 * Sincroniza campanhas diariamente às 6h da manhã
 * Atualiza leads count e métricas
 */

import cron from 'node-cron';
import * as adsService from '../services/meta/adsService.js';
import logger from '../utils/logger.js';

// Flag para evitar execuções simultâneas
let isRunning = false;

/**
 * Tarefa de sincronização
 */
async function syncJob() {
  if (isRunning) {
    logger.info('[MetaAds Cron] Sincronização já em andamento, pulando...');
    return;
  }
  
  isRunning = true;
  
  try {
    logger.info('[MetaAds Cron] Iniciando sincronização diária...');
    
    // 1. Sincroniza campanhas
    const syncResult = await adsService.syncCampaignsWithCache(true); // force = true
    
    // 2. Atualiza contagem de leads
    await adsService.updateCampaignLeadCounts();
    
    logger.info('[MetaAds Cron] Sincronização concluída:', {
      synced: syncResult.synced,
      cached: syncResult.cached,
      errors: syncResult.errors
    });
    
  } catch (error) {
    logger.error('[MetaAds Cron] Erro na sincronização:', error.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Inicia o cron job
 * Roda todos os dias às 6:00 da manhã
 */
export function startMetaAdsCron() {
  // Agenda: 0 6 * * * = 6h00 todos os dias
  const task = cron.schedule('0 6 * * *', syncJob, {
    scheduled: true,
    timezone: 'America/Sao_Paulo' // Fuso horário da clínica
  });
  
  logger.info('[MetaAds Cron] Agendamento configurado: todos os dias às 6h00 (America/Sao_Paulo)');
  
  // Executa uma vez na inicialização (se não tiver dados)
  // Mas respeita o rate limit (só sincroniza se cache expirou)
  setTimeout(async () => {
    try {
      const shouldSync = await adsService.shouldSync();
      if (shouldSync) {
        logger.info('[MetaAds Cron] Primeira sincronização (cache vazio ou expirado)...');
        await syncJob();
      } else {
        logger.info('[MetaAds Cron] Cache válido, pulando sincronização inicial');
      }
    } catch (error) {
      logger.error('[MetaAds Cron] Erro na sincronização inicial:', error.message);
    }
  }, 5000); // Espera 5 segundos após startup
  
  return task;
}

/**
 * Para o cron job (útil para testes)
 */
export function stopMetaAdsCron(task) {
  if (task) {
    task.stop();
    logger.info('[MetaAds Cron] Agendamento parado');
  }
}

/**
 * Executa sincronização manualmente (para testes ou botão no dashboard)
 */
export async function runManualSync() {
  logger.info('[MetaAds Cron] Sincronização manual solicitada');
  return syncJob();
}

export default {
  startMetaAdsCron,
  stopMetaAdsCron,
  runManualSync
};
