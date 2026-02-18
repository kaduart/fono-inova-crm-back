// crons/learningCron.js
// Cron job para análise diária automatizada de conversas

import cron from 'node-cron';
import mongoose from 'mongoose';
import { runLearningCycle, generateHumanReport } from '../services/intelligence/ContinuousLearningService.js';
import { getRedis } from '../services/redisClient.js';

let isRunning = false;

/**
 * 🧠 INICIA O CRON DE APRENDIZADO
 * Roda diariamente às 23:00
 */
export function startLearningCron() {
  console.log('🧠 [CRON] Inicializando cron de aprendizado...');
  
  // Agenda: 0 23 * * * = todo dia às 23:00
  cron.schedule('0 23 * * *', async () => {
    if (isRunning) {
      console.log('⚠️ [CRON] Ciclo anterior ainda em execução, pulando...');
      return;
    }
    
    isRunning = true;
    const startTime = Date.now();
    
    try {
      console.log('\n' + '═'.repeat(60));
      console.log('🧠 [CRON] INICIANDO ANÁLISE DIÁRIA DE APRENDIZADO');
      console.log('📅 ' + new Date().toLocaleString('pt-BR'));
      console.log('═'.repeat(60));
      
      // Executa ciclo completo
      const results = await runLearningCycle();
      
      // Registra no Redis para monitoramento
      const redis = getRedis?.();
      if (redis) {
        // 🛡️ FIX: Redis v4+ usa set com EX ao invés de setex
        await redis.set('learning:last_run', JSON.stringify({
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          conversationsAnalyzed: results.conversationsAnalyzed,
          patternsFound: results.patternsFound,
          problemsDetected: results.problemsDetected,
          testCasesGenerated: results.testCasesGenerated
        }), { EX: 86400 * 7 });
        
        // Alerta se detectou problemas críticos
        if (results.problemsDetected > 0) {
          // 🛡️ FIX: Redis v4+ usa set com EX ao invés de setex
          await redis.set('learning:has_critical_issues', 'true', { EX: 86400 });
        }
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n✅ [CRON] Análise concluída em ${duration}s`);
      
    } catch (error) {
      console.error('❌ [CRON] Erro na análise diária:', error);
      
      // Registra erro no Redis
      const redis = getRedis?.();
      if (redis) {
        // 🛡️ FIX: Redis v4+ usa set com EX ao invés de setex
        await redis.set('learning:last_error', JSON.stringify({
          timestamp: new Date().toISOString(),
          error: error.message,
          stack: error.stack
        }), { EX: 86400 });
      }
      
    } finally {
      isRunning = false;
    }
  }, {
    scheduled: true,
    timezone: 'America/Sao_Paulo'
  });
  
  console.log('✅ [CRON] Agendado: todos os dias às 23:00 (America/Sao_Paulo)');
}

/**
 * 🚀 EXECUÇÃO MANUAL (para testes ou disparo sob demanda)
 */
export async function runManualLearningCycle() {
  console.log('🧠 [MANUAL] Executando ciclo de aprendizado manualmente...');
  
  try {
    const results = await runLearningCycle();
    return results;
  } catch (error) {
    console.error('❌ [MANUAL] Erro:', error);
    throw error;
  }
}

/**
 * 📊 GERA RELATÓRIO PARA VISUALIZAÇÃO
 */
export async function generateDailyReport() {
  return await generateHumanReport(1);
}

/**
 * 📈 GERA RELATÓRIO SEMANAL
 */
export async function generateWeeklyReport() {
  return await generateHumanReport(7);
}

/**
 * 🔍 STATUS DO APRENDIZADO
 */
export async function getLearningStatus() {
  const redis = getRedis?.();
  
  if (!redis) {
    return { error: 'Redis não disponível' };
  }
  
  const [lastRun, lastError, hasIssues] = await Promise.all([
    redis.get('learning:last_run').then(JSON.parse).catch(() => null),
    redis.get('learning:last_error').then(JSON.parse).catch(() => null),
    redis.get('learning:has_critical_issues')
  ]);
  
  return {
    lastRun,
    lastError,
    hasCriticalIssues: hasIssues === 'true',
    isRunning
  };
}

export default {
  startLearningCron,
  runManualLearningCycle,
  generateDailyReport,
  generateWeeklyReport,
  getLearningStatus
};
