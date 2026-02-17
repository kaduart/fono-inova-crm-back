// services/intelligence/ContinuousLearningService.js
// Orquestra análise diária e atualização contínua da Amanda

import ConversationAnalysis from './ConversationAnalysisService.js';
import PatternRecognition from './PatternRecognitionService.js';
import LearningInsight from '../../models/LearningInsight.js';
import { analyzeHistoricalConversations } from '../amandaLearningService.js';
import { analyzeDetectorPerformance, generateAnalysisReport } from '../DetectorLearningService.js';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * 🎯 CONFIGURAÇÃO DE APRENDIZADO
 */
const CONFIG = {
  // Atualiza config a cada X análises com padrões consistentes
  minOccurrencesForUpdate: 5,
  
  // Caminho para salvar test cases gerados
  testCasesPath: './tests/auto-generated',
  
  // Limite de dias para manter histórico
  historyRetentionDays: 90
};

/**
 * 🚀 EXECUTA CICLO COMPLETO DE APRENDIZADO
 */
export async function runLearningCycle() {
  console.log('🧠 [LEARNING] Iniciando ciclo de aprendizado...');
  console.log('═══════════════════════════════════════════════════');
  
  const startTime = Date.now();
  const results = {
    timestamp: new Date(),
    conversationsAnalyzed: 0,
    patternsFound: 0,
    problemsDetected: 0,
    testCasesGenerated: 0,
    configUpdated: false,
    errors: []
  };
  
  try {
    // ═══════════════════════════════════════════════════
    // 1. EXTRAI CONVERSAS DO MONGODB
    // ═══════════════════════════════════════════════════
    console.log('\n📥 Etapa 1: Extraindo conversas do MongoDB...');
    const conversations = await ConversationAnalysis.fetchRecentConversations(7);
    results.conversationsAnalyzed = conversations.length;
    
    if (conversations.length === 0) {
      console.log('⚠️ Nenhuma conversa encontrada para análise');
      return results;
    }
    
    console.log(`✅ ${conversations.length} conversas extraídas`);
    
    // ═══════════════════════════════════════════════════
    // 2. ANALISA CONVERSAS INDIVIDUALMENTE
    // ═══════════════════════════════════════════════════
    console.log('\n🔍 Etapa 2: Analisando conversas...');
    const analyzedConversations = conversations.map(ConversationAnalysis.analyzeConversation);
    
    // Estatísticas rápidas
    const outcomeCounts = analyzedConversations.reduce((acc, c) => {
      acc[c.outcome] = (acc[c.outcome] || 0) + 1;
      return acc;
    }, {});
    
    console.log('📊 Resultados:');
    Object.entries(outcomeCounts).forEach(([outcome, count]) => {
      const emoji = { success: '✅', failure: '❌', engaged: '💬', abandoned: '👻' }[outcome] || '📌';
      console.log(`   ${emoji} ${outcome}: ${count}`);
    });
    
    // ═══════════════════════════════════════════════════
    // 3. RECONHECE PADRÕES
    // ═══════════════════════════════════════════════════
    console.log('\n🎯 Etapa 3: Reconhecendo padrões...');
    const patterns = PatternRecognition.analyzePatterns(analyzedConversations);
    results.patternsFound = patterns.successes.length;
    results.problemsDetected = patterns.problems.length;
    
    console.log(`✅ ${patterns.problems.length} problemas detectados`);
    console.log(`✅ ${patterns.successes.length} padrões de sucesso`);
    
    // Mostra problemas críticos
    const criticalProblems = patterns.problems.filter(p => p.severity === 'critical');
    if (criticalProblems.length > 0) {
      console.log('\n🔴 PROBLEMAS CRÍTICOS:');
      criticalProblems.forEach(p => {
        console.log(`   - ${p.name}: ${p.count}x`);
      });
    }
    
    // ═══════════════════════════════════════════════════
    // 4. COMPARA COM ANÁLISE ANTERIOR
    // ═══════════════════════════════════════════════════
    console.log('\n📊 Etapa 4: Comparando com análise anterior...');
    const comparison = await PatternRecognition.compareWithPreviousAnalysis(patterns);
    
    if (comparison.hasPrevious) {
      console.log(`📅 Análise anterior: ${comparison.previousDate.toLocaleDateString('pt-BR')}`);
      
      if (comparison.changes.length > 0) {
        console.log(`🔄 ${comparison.changes.length} mudanças detectadas:`);
        comparison.changes.forEach(change => {
          const emoji = change.type.includes('problem') ? '⚠️' : '✨';
          console.log(`   ${emoji} ${change.message}`);
        });
      } else {
        console.log('✅ Padrões estáveis');
      }
    } else {
      console.log('🆕 Primeira análise - estabelecendo baseline');
    }
    
    // ═══════════════════════════════════════════════════
    // 5. GERA TEST CASES AUTOMATICAMENTE
    // ═══════════════════════════════════════════════════
    console.log('\n📝 Etapa 5: Gerando test cases...');
    const testCases = await generateTestCases(patterns, analyzedConversations);
    results.testCasesGenerated = testCases.length;
    console.log(`✅ ${testCases.length} test cases gerados`);
    
    // ═══════════════════════════════════════════════════
    // 6. RODA ANÁLISE HISTÓRICA (amandaLearningService)
    // ═══════════════════════════════════════════════════
    console.log('\n📚 Etapa 6: Analisando conversas convertidas...');
    const historicalInsights = await analyzeHistoricalConversations();
    
    if (historicalInsights) {
      console.log(`✅ ${historicalInsights.leadsAnalyzed} leads convertidos analisados`);
    }
    
    // ═══════════════════════════════════════════════════
    // 7. SALVA INSIGHTS NO MONGODB
    // ═══════════════════════════════════════════════════
    console.log('\n💾 Etapa 7: Salvando insights...');
    const saved = await LearningInsight.create({
      type: 'continuous_learning_cycle',
      data: {
        patterns,
        comparison: comparison.changes,
        statistics: patterns.statistics,
        testCasesGenerated: testCases.length
      },
      leadsAnalyzed: analyzedConversations.length,
      conversationsAnalyzed: conversations.length,
      dateRange: {
        from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        to: new Date()
      },
      generatedAt: new Date()
    });
    
    console.log(`✅ Insights salvos: ${saved._id}`);

    // ═══════════════════════════════════════════════════
    // 8. ANALISA PERFORMANCE DOS DETECTORES (FASE 4)
    // ═══════════════════════════════════════════════════
    console.log('\n🎯 Etapa 8: Analisando detectores contextuais...');
    let detectorAnalysis = null;

    try {
      detectorAnalysis = await analyzeDetectorPerformance(7); // Últimos 7 dias

      // Mostra relatório resumido
      const report = generateAnalysisReport(detectorAnalysis);
      console.log(report);

      // Salva análise dos detectores no MongoDB
      await LearningInsight.create({
        type: 'detector_effectiveness',
        data: {
          detectors: detectorAnalysis.detectors,
          newPatternsDiscovered: detectorAnalysis.newPatternsDiscovered
        },
        leadsAnalyzed: 0, // Análise agregada
        conversationsAnalyzed: 0,
        dateRange: {
          from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          to: new Date()
        },
        generatedAt: new Date()
      });

      console.log('✅ Análise de detectores salva');
    } catch (error) {
      console.warn('⚠️ Erro ao analisar detectores:', error.message);
      results.errors.push(`Detector analysis: ${error.message}`);
    }

    // ═══════════════════════════════════════════════════
    // 9. LIMPA DADOS ANTIGOS
    // ═══════════════════════════════════════════════════
    console.log('\n🧹 Etapa 9: Limpando dados antigos...');
    await cleanupOldData();
    
    // ═══════════════════════════════════════════════════
    // RESUMO FINAL
    // ═══════════════════════════════════════════════════
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n' + '═'.repeat(52));
    console.log('✅ CICLO DE APRENDIZADO CONCLUÍDO');
    console.log('═'.repeat(52));
    console.log(`⏱️  Duração: ${duration}s`);
    console.log(`💬 Conversas: ${results.conversationsAnalyzed}`);
    console.log(`🎯 Padrões: ${results.patternsFound}`);
    console.log(`⚠️  Problemas: ${results.problemsDetected}`);
    console.log(`📝 Test cases: ${results.testCasesGenerated}`);
    console.log('═'.repeat(52));
    
    return results;
    
  } catch (error) {
    console.error('❌ [LEARNING] Erro no ciclo:', error);
    results.errors.push(error.message);
    throw error;
  }
}

/**
 * 📝 GERA TEST CASES BASEADOS EM PADRÕES
 */
async function generateTestCases(patterns, conversations) {
  const testCases = [];
  
  // Gera test case para cada problema crítico
  for (const problem of patterns.problems) {
    if (problem.severity === 'critical' || problem.count >= CONFIG.minOccurrencesForUpdate) {
      // Encontra conversas representativas
      const representativeConvs = conversations.filter(c => {
        // Verifica se a conversa tem o problema
        const hasProblem = problem.affectedConversations?.some(
          ac => ac.leadId === c.leadId
        );
        return hasProblem;
      }).slice(0, 3);
      
      for (const conv of representativeConvs) {
        const testCase = {
          name: `${problem.key}_${conv.leadId.slice(-6)}`,
          description: problem.description,
          category: problem.severity === 'critical' ? 'critical' : 'regression',
          pattern: problem.key,
          input: {
            message: extractLeadMessage(conv),
            context: {
              leadStatus: conv.leadStatus,
              topics: conv.topics
            }
          },
          expectedBehavior: problem.suggestion,
          sourceConversation: conv.leadId,
          generatedAt: new Date()
        };
        
        testCases.push(testCase);
      }
    }
  }
  
  // Salva test cases em arquivo se houver
  if (testCases.length > 0) {
    try {
      await fs.mkdir(CONFIG.testCasesPath, { recursive: true });
      
      const filename = `auto-test-cases-${new Date().toISOString().split('T')[0]}.json`;
      const filepath = path.join(CONFIG.testCasesPath, filename);
      
      await fs.writeFile(
        filepath,
        JSON.stringify(testCases, null, 2)
      );
      
      console.log(`💾 Test cases salvos em: ${filepath}`);
    } catch (error) {
      console.warn('⚠️ Não foi possível salvar test cases em arquivo:', error.message);
    }
  }
  
  return testCases;
}

/**
 * 🧹 LIMPA DADOS ANTIGOS
 */
async function cleanupOldData() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.historyRetentionDays);
  
  try {
    // Remove insights antigos
    const deleted = await LearningInsight.deleteMany({
      type: 'continuous_learning_cycle',
      generatedAt: { $lt: cutoffDate }
    });
    
    console.log(`🗑️  ${deleted.deletedCount} registros antigos removidos`);
    
    // Limpa arquivos de test cases antigos (manter últimos 30 dias)
    try {
      const files = await fs.readdir(CONFIG.testCasesPath);
      const cutoffFileDate = new Date();
      cutoffFileDate.setDate(cutoffFileDate.getDate() - 30);
      
      for (const file of files) {
        if (file.startsWith('auto-test-cases-')) {
          const filepath = path.join(CONFIG.testCasesPath, file);
          const stats = await fs.stat(filepath);
          
          if (stats.mtime < cutoffFileDate) {
            await fs.unlink(filepath);
            console.log(`🗑️  Removido: ${file}`);
          }
        }
      }
    } catch (error) {
      // Ignora erro se diretório não existe
    }
    
  } catch (error) {
    console.warn('⚠️ Erro ao limpar dados antigos:', error.message);
  }
}

/**
 * 📊 GERA RELATÓRIO PARA HUMANOS
 */
export async function generateHumanReport(days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  
  // Busca análises recentes
  const analyses = await LearningInsight.find({
    type: 'continuous_learning_cycle',
    generatedAt: { $gte: since }
  }).sort({ generatedAt: -1 });
  
  if (analyses.length === 0) {
    return 'Nenhuma análise encontrada no período.';
  }
  
  const latest = analyses[0];
  const patterns = latest.data?.patterns || {};
  
  let report = PatternRecognition.formatPatternReport(patterns);
  
  // Adiciona tendência se houver múltiplas análises
  if (analyses.length > 1) {
    report += '\n\n📈 TENDÊNCIA (' + days + ' dias)\n';
    
    const successRates = analyses.map(a => {
      const stats = a.data?.patterns?.statistics?.byOutcome || {};
      const total = Object.values(stats).reduce((s, v) => s + v, 0);
      const success = stats.success || 0;
      return total > 0 ? (success / total * 100).toFixed(1) : 0;
    });
    
    const trend = successRates[0] - successRates[successRates.length - 1];
    const trendEmoji = trend > 0 ? '📈' : trend < 0 ? '📉' : '➡️';
    
    report += `   ${trendEmoji} Taxa de sucesso: ${successRates[successRates.length - 1]}% → ${successRates[0]}%`;
  }
  
  return report;
}

/**
 * 🔍 BUSCA INSIGHTS ESPECÍFICOS
 */
export async function getInsightsForContext(context) {
  const { topic, outcome, minConfidence = 0.7 } = context;
  
  // Busca insights recentes
  const latest = await LearningInsight.findOne({
    type: 'continuous_learning_cycle'
  }).sort({ generatedAt: -1 });
  
  if (!latest) return null;
  
  const patterns = latest.data?.patterns || {};
  const relevantInsights = [];
  
  // Filtra por tópico
  if (topic) {
    const topicInsights = patterns.insights?.filter(i => 
      i.title?.toLowerCase().includes(topic.toLowerCase()) ||
      i.description?.toLowerCase().includes(topic.toLowerCase())
    );
    relevantInsights.push(...(topicInsights || []));
  }
  
  // Filtra por outcome
  if (outcome) {
    const outcomePatterns = patterns[outcome === 'success' ? 'successes' : 'problems'];
    relevantInsights.push(...(outcomePatterns || []));
  }
  
  return {
    timestamp: latest.generatedAt,
    insights: relevantInsights.slice(0, 5),
    raw: patterns
  };
}

// ==================== HELPERS ====================

function extractLeadMessage(conv) {
  // Pega a primeira mensagem do lead ou a que desencadeou o problema
  const inboundMessages = conv.messages?.filter(m => m.direction === 'inbound');
  
  if (inboundMessages && inboundMessages.length > 0) {
    // Retorna a mensagem mais longa (provavelmente mais informativa)
    return inboundMessages.sort((a, b) => 
      (b.content || '').length - (a.content || '').length
    )[0].content;
  }
  
  return '';
}

// Exportações
export default {
  runLearningCycle,
  generateHumanReport,
  getInsightsForContext,
  CONFIG
};
