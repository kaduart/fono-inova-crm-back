#!/usr/bin/env node
/**
 * 🔍 VERIFICA STATUS DO SISTEMA CONTÍNUO
 * 
 * Checa se os crons de aprendizado e regressão estão funcionando
 */

import mongoose from 'mongoose';
import { getRedis } from '../../services/redisClient.js';
import 'dotenv/config';

const MONGO_URI = process.env.MONGO_URI;

console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🔍 STATUS DO SISTEMA CONTÍNUO - Amanda Intelligence           ║
╚════════════════════════════════════════════════════════════════╝
`);

async function checkStatus() {
  // Conecta no MongoDB
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB conectado\n');
  
  // Verifica Redis
  const redis = getRedis?.();
  if (!redis) {
    console.log('❌ Redis não disponível - não é possível verificar status\n');
    process.exit(1);
  }
  
  console.log('📊 VERIFICANDO CRONS:\n');
  
  // Verifica Learning Cron
  const lastRun = await redis.get('learning:last_run').then(JSON.parse).catch(() => null);
  const lastError = await redis.get('learning:last_error').then(JSON.parse).catch(() => null);
  const hasIssues = await redis.get('learning:has_critical_issues');
  
  console.log('🧠 LEARNING CRON (Aprendizado):');
  console.log('   ⏰ Agenda: Todo dia às 23:00');
  
  if (lastRun) {
    const data = new Date(lastRun.timestamp);
    const diffHours = (Date.now() - data) / (1000 * 60 * 60);
    const status = diffHours < 25 ? '✅ ATIVO' : '⚠️  ATRASADO';
    
    console.log(`   ${status} - Última execução:`);
    console.log(`      Data: ${data.toLocaleString('pt-BR')}`);
    console.log(`      Conversas analisadas: ${lastRun.conversationsAnalyzed || 'N/A'}`);
    console.log(`      Padrões encontrados: ${lastRun.patternsFound || 'N/A'}`);
    console.log(`      Problemas detectados: ${lastRun.problemsDetected || 0}`);
    console.log(`      Testes gerados: ${lastRun.testCasesGenerated || 0}`);
    console.log(`      Duração: ${(lastRun.duration / 1000).toFixed(1)}s`);
  } else {
    console.log('   ❌ NUNCA EXECUTADO ou sem registro');
  }
  
  if (hasIssues === 'true') {
    console.log('   🚨 ALERTA: Problemas críticos detectados na última análise!');
  }
  
  if (lastError) {
    console.log(`   ❌ ÚLTIMO ERRO: ${lastError.timestamp}`);
    console.log(`      ${lastError.error}`);
  }
  
  console.log('\n🧪 REGRESSION CRON (Testes):');
  console.log('   ⏰ Agenda: Todo dia às 00:00');
  console.log('   ℹ️  Status: Verificar manualmente nos logs do servidor');
  
  // Verifica Learning Insights no MongoDB
  console.log('\n📈 DADOS NO MONGODB:\n');
  
  const LearningInsight = mongoose.model('LearningInsight', new mongoose.Schema({}, { strict: false }));
  const totalInsights = await LearningInsight.countDocuments();
  const ultimos7Dias = await LearningInsight.countDocuments({
    generatedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
  });
  
  console.log(`   Total de insights gerados: ${totalInsights}`);
  console.log(`   Insights últimos 7 dias: ${ultimos7Dias}`);
  
  if (totalInsights > 0) {
    const ultimo = await LearningInsight.findOne().sort({ generatedAt: -1 });
    console.log(`   Último insight: ${ultimo?.generatedAt?.toLocaleString('pt-BR') || 'N/A'}`);
    console.log(`   Tipo: ${ultimo?.type || 'N/A'}`);
  }
  
  // Verifica se tem padrões minerados
  const Pattern = mongoose.model('Pattern', new mongoose.Schema({}, { strict: false }), 'patterns');
  const totalPatterns = await Pattern.countDocuments().catch(() => 0);
  console.log(`   Padrões minerados: ${totalPatterns}`);
  
  console.log('\n' + '═'.repeat(64));
  
  // Diagnóstico final
  console.log('\n📋 DIAGNÓSTICO:\n');
  
  if (!lastRun) {
    console.log('🔴 CRÍTICO: O sistema de aprendizado NUNCA rodou!');
    console.log('   → Verifique se o server.js está rodando');
    console.log('   → Verifique os logs do servidor');
  } else if (lastError && !lastRun) {
    console.log('🔴 CRÍTICO: O sistema está com erros e não consegue rodar');
    console.log(`   → Erro: ${lastError.error}`);
  } else if (hasIssues === 'true') {
    console.log('🟡 ATENÇÃO: Sistema rodando, mas detectou problemas na Amanda');
    console.log('   → Verifique o relatório gerado');
    console.log('   → Considere rodar o replay manual para análise');
  } else {
    console.log('🟢 Sistema contínuo está ATIVO e funcionando!');
    console.log('   → O aprendizado está ocorrendo automaticamente');
    console.log('   → Testes de regressão rodando diariamente');
  }
  
  console.log('\n💡 PRÓXIMOS PASSOS:\n');
  console.log('1. Para ver relatório gerado automaticamente:');
  console.log('   → Verifique a collection LearningInsight no MongoDB');
  console.log('   → Ou rode: node scripts/amanda/verificar-sistema-continuo.js');
  console.log('\n2. Para análise manual detalhada:');
  console.log('   → Rode: node scripts/amanda/replay-conversas-reais.js --limit=100');
  console.log('\n3. Para executar aprendizado manualmente:');
  console.log('   → Importe e rode: runManualLearningCycle()');
  
  await mongoose.disconnect();
  console.log('\n✅ Verificação concluída!\n');
}

checkStatus().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
