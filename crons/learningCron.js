// crons/learningCron.js
// Cron job para análise diária automatizada de conversas + teste do site

import cron from 'node-cron';
import mongoose from 'mongoose';
import { runLearningCycle, generateHumanReport } from '../services/intelligence/ContinuousLearningService.js';
import { getRedis, startRedis } from '../services/redisClient.js';
import { runSiteTestManual } from './siteTest.cron.js';

let isRunning = false;

/**
 * 🔌 Garante que o Redis está conectado
 */
async function ensureRedisConnection() {
  try {
    const redis = getRedis?.();
    if (!redis) {
      console.log('⚠️ Redis não inicializado, tentando conectar...');
      await startRedis();
      return getRedis?.();
    }
    
    // Testa se está realmente conectado
    await redis.ping();
    return redis;
  } catch (err) {
    console.log('🔌 Redis desconectado, tentando reconectar...');
    try {
      await startRedis();
      return getRedis?.();
    } catch (reconnectErr) {
      console.error('❌ Falha ao reconectar Redis:', reconnectErr.message);
      return null;
    }
  }
}

/**
 * 🔒 LOCK DISTRIBUÍDO - Evita múltiplas instâncias rodando no Render
 */
async function acquireLock(redis, lockKey, ttlSeconds = 3600) {
  try {
    const token = `${process.env.RENDER_INSTANCE_ID || 'local'}-${Date.now()}`;
    const result = await redis.set(lockKey, token, { NX: true, EX: ttlSeconds });
    return result === 'OK' ? token : null;
  } catch (err) {
    console.error('🔒 Erro ao adquirir lock:', err.message);
    return null;
  }
}

async function releaseLock(redis, lockKey, token) {
  try {
    const current = await redis.get(lockKey);
    if (current === token) {
      await redis.del(lockKey);
    }
  } catch (err) {
    console.error('🔒 Erro ao liberar lock:', err.message);
  }
}

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
    
    // 🔒 LOCK DISTRIBUÍDO - Só uma instância roda (importante no Render)
    const redis = await ensureRedisConnection();
    const lockKey = 'cron:learning:lock';
    const lockToken = redis ? await acquireLock(redis, lockKey, 3600) : 'no-redis';
    
    if (!lockToken) {
      console.log('🔒 [CRON] Outra instância já está executando, pulando...');
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
      
      // Garante conexão com Redis antes de salvar status
      const redis = await ensureRedisConnection();
      
      if (redis) {
        try {
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
            await redis.set('learning:has_critical_issues', 'true', { EX: 86400 });
          }
          
          console.log('💾 Status salvo no Redis');
        } catch (redisErr) {
          console.error('⚠️ Erro ao salvar no Redis:', redisErr.message);
        }
      } else {
        console.log('⚠️ Redis indisponível, status não será salvo');
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n✅ [CRON] Análise concluída em ${duration}s`);
      
      // 🌐 TESTE DO SITE - Após learning cycle
      console.log('\n🌐 [CRON] Iniciando teste do site...');
      try {
        await runSiteTestManual();
        console.log('✅ [CRON] Teste do site concluído');
      } catch (siteError) {
        console.error('⚠️ [CRON] Erro no teste do site:', siteError.message);
        // Não falha o ciclo se o teste falhar
      }
      
    } catch (error) {
      console.error('❌ [CRON] Erro na análise diária:', error);
      
      // Tenta salvar erro no Redis
      const redis = await ensureRedisConnection();
      if (redis) {
        try {
          await redis.set('learning:last_error', JSON.stringify({
            timestamp: new Date().toISOString(),
            error: error.message,
            stack: error.stack
          }), { EX: 86400 });
        } catch (redisErr) {
          console.error('⚠️ Erro ao salvar erro no Redis:', redisErr.message);
        }
      }
      
    } finally {
      isRunning = false;
      // 🔒 Libera o lock
      if (lockToken && lockToken !== 'no-redis' && redis) {
        await releaseLock(redis, lockKey, lockToken);
      }
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
  
  // Garante Redis conectado
  await ensureRedisConnection();
  
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
  const redis = await ensureRedisConnection();
  
  if (!redis) {
    return { error: 'Redis não disponível', isRunning };
  }
  
  try {
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
  } catch (err) {
    return { error: err.message, isRunning };
  }
}

export default {
  startLearningCron,
  runManualLearningCycle,
  generateDailyReport,
  generateWeeklyReport,
  getLearningStatus
};
