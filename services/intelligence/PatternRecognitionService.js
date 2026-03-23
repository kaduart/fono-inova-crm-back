// services/intelligence/PatternRecognitionService.js
// Detecta padrões de sucesso e falha nas conversas analisadas

import { analyzeHistoricalConversations } from '../amandaLearningService.js';
import LearningInsight from '../../models/LearningInsight.js';

/**
 * 🎯 CONFIGURAÇÃO DE RECONHECIMENTO
 */
const CONFIG = {
  // Mínimo de ocorrências para considerar um padrão
  minOccurrences: 3,
  
  // Threshold de sucesso (%) para considerar uma resposta "efetiva"
  successThreshold: 70,
  
  // Threshold de falha (%) para considerar um padrão problemático
  failureThreshold: 60
};

/**
 * 📊 PADRÕES CONHECIDOS DE PROBLEMAS
 */
const KNOWN_PROBLEM_PATTERNS = {
  multiple_children: {
    name: 'Múltiplos Filhos',
    description: 'Lead menciona ter mais de uma criança',
    patterns: [
      /\b(duas?|dois)\s+(crian[çc]as?|filhos?|filhas?)\b/i,
      /\btr[eê]s\s+(crian[çc]as?|filhos?|filhas?)\b/i,
      /\bmeus\s+(filhos?|filhas?)\b/i,
      /\b(as?|os?)\s+duas?\b/i,
      /\bgêmeos?\b/i
    ],
    severity: 'high',
    suggestion: 'Perguntar idade de cada criança separadamente e oferecer desconto familiar'
  },
  
  early_price_question: {
    name: 'Pergunta Precoce de Preço',
    description: 'Lead pergunta preço na 1ª ou 2ª mensagem',
    patterns: [
      /\b(pre[çc]o|valor|quanto)\b/i
    ],
    earlyMessageThreshold: 2,
    severity: 'medium',
    suggestion: 'Valorizar antes de falar preço. Contexto: lead ainda não sabe o valor da terapia',
    // 🔴 DEPRECATED: Funcionalidade movida para PriceDetector.isEarlyQuestion
    // Monitore por 30 dias antes de remover (adicionado em 2026-02-16)
    deprecated: true,
    deprecatedSince: '2026-02-16',
    replacedBy: 'PriceDetector.isEarlyQuestion'
  },
  
  cancellation: {
    name: 'Intenção de Cancelamento',
    description: 'Lead quer cancelar ou desistir',
    patterns: [
      /\b(cancelar|desistir|n[aã]o\s+vou\s+conseguir|imprevisto)\b/i,
      /\b(n[aã]o\s+posso\s+mais|mudei\s+de\s+ideia)\b/i
    ],
    severity: 'critical',
    suggestion: 'Oferecer reagendamento flexível, entender motivo real',
    // 🔴 DEPRECATED: Funcionalidade movida para SchedulingDetector.schedulingType='cancellation'
    // Duplicação de 95%+ com detector contextual
    // Monitore por 30 dias antes de remover (adicionado em 2026-02-16)
    deprecated: true,
    deprecatedSince: '2026-02-16',
    replacedBy: 'SchedulingDetector.schedulingType=cancellation'
  },
  
  time_confusion: {
    name: 'Confusão com Horários',
    description: 'Lead não entende ou confunde horários',
    patterns: [
      /\b(n[aã]o\s+entendi|confuso|complicado)\s+(hor[áa]rio|hora|horario)\b/i,
      /\bquais\s+os\s+hor[áa]rios\?/i,
      /\btem\s+vaga\s+(quando|que\s+hora)/i
    ],
    severity: 'medium',
    suggestion: 'Apresentar slots de forma mais visual e clara'
  },
  
  insurance_confusion: {
    name: 'Confusão com Convênio',
    description: 'Lead acha que atende convênio ou pede reembolso',
    patterns: [
      /\b(conv[eê]nio|plano\s+de\s+sa[uú]de|sulamerica|unimed)\b/i,
      /\b(reembolso|particular\s*[\-–]\s*conv[eê]nio)\b/i
    ],
    severity: 'medium',
    suggestion: 'Explicar claramente modalidade particular com reembolso',
    // 🔴 DEPRECATED: Funcionalidade movida para InsuranceDetector.intentType='confusion'
    // Monitore por 30 dias antes de remover (adicionado em 2026-02-16)
    deprecated: true,
    deprecatedSince: '2026-02-16',
    replacedBy: 'InsuranceDetector.intentType=confusion / isConfused flag'
  },
  
  silence_after_price: {
    name: 'Silêncio Após Preço',
    description: 'Lead para de responder após saber o valor',
    test: (conversation) => {
      const { messages, outcome } = conversation;
      if (outcome === 'success') return false;
      if (!messages || !Array.isArray(messages)) return false;
      
      // Procura mensagem com preço seguida de não-resposta
      const priceIndex = messages.findIndex(m => 
        m.direction === 'outbound' && 
        /\b(pre[çc]o|valor|r\$|reais?)\b/i.test(m.content || '')
      );
      
      if (priceIndex === -1) return false;
      
      // Verifica se não houve resposta ou foi evasiva
      const nextMessages = messages.slice(priceIndex + 1);
      const hasMeaningfulResponse = nextMessages.some(m => 
        m.direction === 'inbound' && 
        (m.content || '').length > 10 &&
        !/^(ok|aham|hm|obrigad|valeu|t[áa])\b/i.test(m.content || '')
      );
      
      return !hasMeaningfulResponse;
    },
    severity: 'high',
    suggestion: 'Seguir com valorização após preço, oferecer opções de parcelamento'
  },
  
  generic_response: {
    name: 'Resposta Genérica da Amanda',
    description: 'Amanda deu resposta genérica que não ajudou',
    patterns: [
      /^como posso (te )?ajudar/i,
      /^entendi\.\s*qual/i,
      /^ok,\s*(entendi|compreendi)/i
    ],
    severity: 'high',
    suggestion: 'Melhorar contexto para respostas mais específicas'
  }
};

/**
 * 🔍 ANALISA PADRÕES EM CONVERSAS
 */
export function analyzePatterns(conversations) {
  const patterns = {
    problems: [],
    successes: [],
    insights: [],
    statistics: {
      totalAnalyzed: conversations.length,
      byOutcome: {}
    }
  };
  
  // Contagem por outcome
  for (const conv of conversations) {
    const outcome = conv.outcome || 'unknown';
    patterns.statistics.byOutcome[outcome] = (patterns.statistics.byOutcome[outcome] || 0) + 1;
  }
  
  // Detecta cada padrão de problema
  for (const [key, config] of Object.entries(KNOWN_PROBLEM_PATTERNS)) {
    const detected = detectPatternInConversations(conversations, key, config);
    if (detected.count >= CONFIG.minOccurrences) {
      patterns.problems.push({
        key,
        ...config,
        count: detected.count,
        affectedConversations: detected.conversations,
        successRate: calculateSuccessRate(detected.conversations),
        recommendation: generateRecommendation(key, detected),
        // 🔴 Marca se padrão está deprecated
        isDeprecated: !!config.deprecated,
        ...(config.deprecated && {
          deprecationInfo: {
            since: config.deprecatedSince,
            replacedBy: config.replacedBy
          }
        })
      });
    }
  }
  
  // Detecta padrões de sucesso
  patterns.successes = detectSuccessPatterns(conversations);
  
  // Gera insights gerais
  patterns.insights = generateInsights(conversations, patterns);
  
  return patterns;
}

/**
 * 🎯 DETECTA UM PADRÃO ESPECÍFICO
 */
function detectPatternInConversations(conversations, patternKey, config) {
  const detected = {
    count: 0,
    conversations: []
  };
  
  for (const conv of conversations) {
    let matched = false;
    
    // Testa por regex patterns
    if (config.patterns) {
      const allText = conv.messages
        ?.map(m => m.content || '')
        .join(' ') || '';
      
      matched = config.patterns.some(p => p.test(allText));
    }
    
    // Testa por função customizada
    if (!matched && config.test) {
      matched = config.test(conv);
    }
    
    // Verifica early message threshold (para preço precoce)
    if (matched && config.earlyMessageThreshold) {
      const priceMessageIndex = conv.messages?.findIndex(m => 
        /\b(pre[çc]o|valor|quanto)\b/i.test(m.content || '')
      ) ?? -1;
      
      if (priceMessageIndex === -1 || priceMessageIndex > config.earlyMessageThreshold) {
        matched = false;
      }
    }
    
    if (matched) {
      detected.count++;
      detected.conversations.push({
        leadId: conv.leadId,
        outcome: conv.outcome,
        messageCount: conv.messageCount,
        topics: conv.topics
      });
    }
  }
  
  return detected;
}

/**
 * ✅ DETECTA PADRÕES DE SUCESSO
 */
function detectSuccessPatterns(conversations) {
  const successes = [];
  const successfulConvs = conversations.filter(c => c.outcome === 'success');
  
  if (successfulConvs.length === 0) return successes;
  
  // Analisa mensagens da Amanda que precedem agendamento
  const closingMessages = [];
  
  for (const conv of successfulConvs) {
    if (!conv.messages || conv.messages.length < 2) continue;
    
    // Últimas mensagens antes do lead confirmar
    const lastExchanges = conv.messages.slice(-4);
    const amandaMessages = lastExchanges.filter(m => m.direction === 'outbound');
    
    for (const msg of amandaMessages) {
      const content = (msg.content || '').toLowerCase();
      
      // Detecta técnicas de fechamento
      if (/\b(agendar|marcar|confirmar|vaga|hor[áa]rio)\b/.test(content)) {
        closingMessages.push({
          type: 'scheduling_prompt',
          content: msg.content,
          technique: detectClosingTechnique(content)
        });
      }
      
      // Detecta abordagens de valorização
      if (/\b(resultado|melhorar|evolu[çc][aã]o|qualidade|benef[ií]cio)\b/.test(content)) {
        closingMessages.push({
          type: 'value_reinforcement',
          content: msg.content,
          technique: 'value_based_closing'
        });
      }
    }
  }
  
  // Agrupa técnicas mais usadas
  const techniqueCount = {};
  for (const msg of closingMessages) {
    techniqueCount[msg.technique] = (techniqueCount[msg.technique] || 0) + 1;
  }
  
  // Top técnicas
  const topTechniques = Object.entries(techniqueCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  
  for (const [technique, count] of topTechniques) {
    if (count >= CONFIG.minOccurrences) {
      const examples = closingMessages
        .filter(m => m.technique === technique)
        .slice(0, 3)
        .map(m => m.content);
      
      successes.push({
        technique,
        count,
        examples,
        effectiveness: Math.round((count / successfulConvs.length) * 100)
      });
    }
  }
  
  return successes;
}

/**
 * 📊 CALCULA TAXA DE SUCESSO
 */
function calculateSuccessRate(conversations) {
  if (conversations.length === 0) return 0;
  
  const successes = conversations.filter(c => c.outcome === 'success').length;
  return Math.round((successes / conversations.length) * 100);
}

/**
 * 💡 GERA INSIGHTS GERAIS
 */
function generateInsights(conversations, patterns) {
  const insights = [];
  
  // Insight: Tópicos mais comuns em conversas de sucesso
  const successTopics = {};
  const successfulConvs = conversations.filter(c => c.outcome === 'success');
  
  for (const conv of successfulConvs) {
    for (const topic of (conv.topics || [])) {
      successTopics[topic] = (successTopics[topic] || 0) + 1;
    }
  }
  
  const topSuccessTopics = Object.entries(successTopics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  
  if (topSuccessTopics.length > 0) {
    insights.push({
      type: 'success_factors',
      title: 'Tópicos em Conversas de Sucesso',
      description: `Conversas que converteram frequentemente mencionaram: ${topSuccessTopics.map(t => t[0]).join(', ')}`,
      data: topSuccessTopics
    });
  }
  
  // Insight: Duração média de conversas
  const avgDuration = Math.round(
    conversations.reduce((sum, c) => sum + (c.metrics?.durationMinutes || 0), 0) / conversations.length
  );
  
  const successDuration = Math.round(
    successfulConvs.reduce((sum, c) => sum + (c.metrics?.durationMinutes || 0), 0) / successfulConvs.length
  ) || 0;
  
  insights.push({
    type: 'timing',
    title: 'Duração das Conversas',
    description: `Média geral: ${avgDuration}min | Conversas convertidas: ${successDuration}min`,
    recommendation: successDuration > 0 
      ? `Conversas de sucesso duram em média ${successDuration}min. Manter engajamento por pelo menos ${Math.round(successDuration * 0.7)}min.`
      : 'Dados insuficientes sobre duração'
  });
  
  // Insight: Padrões críticos
  const criticalProblems = patterns.problems.filter(p => p.severity === 'critical');
  if (criticalProblems.length > 0) {
    insights.push({
      type: 'critical_issues',
      title: 'Problemas Críticos Detectados',
      description: `${criticalProblems.length} padrões críticos encontrados`,
      issues: criticalProblems.map(p => ({
        name: p.name,
        count: p.count,
        successRate: p.successRate
      }))
    });
  }
  
  return insights;
}

/**
 * 🔧 GERA RECOMENDAÇÕES ESPECÍFICAS
 */
function generateRecommendation(patternKey, detected) {
  const baseSuggestion = KNOWN_PROBLEM_PATTERNS[patternKey]?.suggestion || '';
  
  // Adiciona contexto baseado nos dados
  if (detected.count >= 10) {
    return `${baseSuggestion} (Padrão frequente - ${detected.count} ocorrências. Priorizar correção.)`;
  }
  
  if (detected.successRate < 30) {
    return `${baseSuggestion} (Taxa de sucesso baixa: ${detected.successRate}%. Revisar abordagem.)`;
  }
  
  return baseSuggestion;
}

/**
 * 🎯 DETECTA TÉCNICA DE FECHAMENTO
 */
function detectClosingTechnique(message) {
  const content = message.toLowerCase();
  
  if (/\b(agora|hoje|j[aá])\b/.test(content) && /\b(vaga|hor[áa]rio)\b/.test(content)) {
    return 'urgency_scheduling';
  }
  
  if (/\b(vamos|posso)\s+(agendar|marcar)\b/.test(content)) {
    return ' assumptive_close';
  }
  
  if (/\b(prefere|qual\s+(dia|hor[áa]rio)|op[çc][oõ]es)\b/.test(content)) {
    return 'alternative_close';
  }
  
  if (/\b(confirm|tudo\s+certo|fechado)\b/.test(content)) {
    return 'confirmation_close';
  }
  
  return 'direct_scheduling';
}

/**
 * 📈 COMPARA COM ANÁLISES ANTERIORES
 */
export async function compareWithPreviousAnalysis(currentPatterns) {
  try {
    const previous = await LearningInsight.findOne({
      type: 'conversation_patterns'
    }).sort({ generatedAt: -1 });
    
    if (!previous) {
      return {
        hasPrevious: false,
        changes: []
      };
    }
    
    const changes = [];
    const prevData = previous.data || {};
    
    // Compara problemas
    const currentProblems = currentPatterns.problems || [];
    const prevProblems = prevData.problems || [];
    
    for (const problem of currentProblems) {
      const prevProblem = prevProblems.find(p => p.key === problem.key);
      
      if (!prevProblem) {
        changes.push({
          type: 'new_problem',
          problem: problem.key,
          severity: problem.severity,
          message: `Novo padrão detectado: ${problem.name} (${problem.count} ocorrências)`
        });
      } else if (problem.count > prevProblem.count * 1.5) {
        changes.push({
          type: 'increasing_problem',
          problem: problem.key,
          previousCount: prevProblem.count,
          currentCount: problem.count,
          message: `Aumento em ${problem.name}: ${prevProblem.count} → ${problem.count}`
        });
      }
    }
    
    // Compara sucessos
    const currentSuccesses = currentPatterns.successes || [];
    const prevSuccesses = prevData.successes || [];
    
    for (const success of currentSuccesses) {
      const prevSuccess = prevSuccesses.find(s => s.technique === success.technique);
      
      if (!prevSuccess) {
        changes.push({
          type: 'new_success_pattern',
          technique: success.technique,
          message: `Nova técnica de sucesso: ${success.technique} (${success.effectiveness}% efetividade)`
        });
      }
    }
    
    return {
      hasPrevious: true,
      previousDate: previous.generatedAt,
      changes
    };
    
  } catch (error) {
    console.error('❌ [PATTERN] Erro ao comparar com análise anterior:', error);
    return { hasPrevious: false, changes: [], error: error.message };
  }
}

/**
 * 🎨 FORMATA RESULTADOS PARA RELATÓRIO
 */
export function formatPatternReport(patterns) {
  const lines = [];
  
  lines.push('╔════════════════════════════════════════════════════════╗');
  lines.push('║     📊 RELATÓRIO DE PADRÕES DE CONVERSAÇÃO            ║');
  lines.push('╚════════════════════════════════════════════════════════╝');
  lines.push('');
  
  // Estatísticas
  lines.push('📈 ESTATÍSTICAS GERAIS');
  lines.push(`   Total analisado: ${patterns.statistics.totalAnalyzed} conversas`);
  Object.entries(patterns.statistics.byOutcome).forEach(([outcome, count]) => {
    const emoji = outcome === 'success' ? '✅' : outcome === 'failure' ? '❌' : '📌';
    lines.push(`   ${emoji} ${outcome}: ${count}`);
  });
  lines.push('');
  
  // Problemas
  if (patterns.problems.length > 0) {
    lines.push('⚠️  PADRÕES DE PROBLEMA DETECTADOS');
    patterns.problems.forEach(p => {
      const severityEmoji = p.severity === 'critical' ? '🔴' : p.severity === 'high' ? '🟠' : '🟡';
      lines.push(`   ${severityEmoji} ${p.name}: ${p.count}x (sucesso: ${p.successRate}%)`);
      lines.push(`      💡 ${p.recommendation}`);
    });
    lines.push('');
  }
  
  // Sucessos
  if (patterns.successes.length > 0) {
    lines.push('✅ PADRÕES DE SUCESSO');
    patterns.successes.forEach(s => {
      lines.push(`   🎯 ${s.technique}: ${s.count}x (${s.effectiveness}% efetivo)`);
    });
    lines.push('');
  }
  
  // Insights
  if (patterns.insights.length > 0) {
    lines.push('💡 INSIGHTS');
    patterns.insights.forEach(i => {
      lines.push(`   📌 ${i.title}`);
      lines.push(`      ${i.description}`);
      if (i.recommendation) {
        lines.push(`      → ${i.recommendation}`);
      }
    });
  }
  
  return lines.join('\n');
}

export default {
  analyzePatterns,
  compareWithPreviousAnalysis,
  formatPatternReport,
  KNOWN_PROBLEM_PATTERNS
};
