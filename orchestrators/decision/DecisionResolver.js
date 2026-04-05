/**
 * 🧠 DECISION RESOLVER - Motor Central de Decisão da Amanda
 * 
 * Arquitetura: 2 Níveis (Domínio + Ação)
 * - Nível 1: Seleciona domínio dominante (price, scheduling, confirmation, insurance)
 * - Nível 2: Decide ação dentro do domínio (RULE / HYBRID / AI)
 * 
 * Versão: 2.0 - Produção
 * Data: 2026-04-04
 */

import Logger from '../../services/utils/Logger.js';

const logger = new Logger('DecisionResolver');

// ═════════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO POR DOMÍNIO - Thresholds e pesos específicos
// ═════════════════════════════════════════════════════════════════════════════

const DOMAIN_CONFIG = {
  price: {
    thresholds: { RULE: 0.85, HYBRID: 0.60 },
    maxExpectedScore: 1.5, // Para cálculo de systemConfidence
    typeWeights: {
      acceptance: 1.3,
      insistence: 1.2,
      objection: 1.1,
      comparison: 1.0,
      negotiation: 0.9,
      generic: 0.7
    },
    contextMultipliers: {
      isEarlyQuestion: 0.9,
      alreadyMentioned: 1.15,
      priceAlreadyDiscussed: 1.1
    }
  },
  
  scheduling: {
    thresholds: { RULE: 0.80, HYBRID: 0.55 },
    maxExpectedScore: 1.4,
    typeWeights: {
      urgent: 1.3,
      specific_date: 1.2,
      period_preference: 1.1,
      generic: 0.8
    },
    contextMultipliers: {
      hasPendingSlots: 1.2,
      stateIsScheduling: 1.15,
      firstContact: 0.85
    }
  },
  
  confirmation: {
    thresholds: { RULE: 0.90, HYBRID: 0.70 }, // Mais rigoroso (evitar erro)
    maxExpectedScore: 1.6,
    typeWeights: {
      accept_slot: 1.4,
      accept_price: 1.3,
      accept_plan: 1.2,
      tentative: 0.8,
      ambiguous: 0.6
    },
    contextMultipliers: {
      requiresValidation: 0.7,
      slotPending: 1.2
    }
  },
  
  insurance: {
    thresholds: { RULE: 0.85, HYBRID: 0.65 },
    maxExpectedScore: 1.3,
    typeWeights: {
      specific_plan: 1.2,
      general_question: 1.0,
      confusion: 0.9,
      concern: 0.85
    },
    contextMultipliers: {
      isSpecific: 1.1,
      isConfused: 0.9
    }
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// NÍVEL 1: SELEÇÃO DE DOMÍNIO
// ═════════════════════════════════════════════════════════════════════════════

function selectDomain(detectorResults, context, contextModifiers = null) {
  const domainScores = {};
  
  for (const [domain, data] of Object.entries(detectorResults)) {
    if (!data?.detected) continue;
    
    const config = DOMAIN_CONFIG[domain];
    if (!config) continue;
    
    // 1. Confidence base do detector
    let rawScore = data.confidence || 0;
    
    // 2. Peso do tipo específico (priceType, confirmationType, etc.)
    const typeKey = data.priceType || data.confirmationType || data.intentType || 'generic';
    const typeWeight = config.typeWeights[typeKey] || 1.0;
    rawScore *= typeWeight;
    
    // 3. Multiplicadores de contexto (APENAS data[key], não context[key] direto)
    for (const [key, multiplier] of Object.entries(config.contextMultipliers)) {
      // Só aplica se o PRÓPRIO detector sinalizar (não do contexto geral)
      if (data[key] === true) {
        rawScore *= multiplier;
      }
    }
    
    // 4. Ajuste por estado global (reforça domínio coerente com estado)
    if (domain === 'scheduling' && context.currentState === 'SCHEDULING') {
      rawScore *= 1.15;
    }
    if (domain === 'price' && context.currentState === 'NEGOTIATING') {
      rawScore *= 1.1;
    }
    if (domain === 'confirmation' && context.hasPendingSlots) {
      rawScore *= 1.1;
    }
    
    // 🆕 5. Aplicar modificadores das RNs de negócio
    if (contextModifiers?.scoreMultiplier) {
      rawScore *= contextModifiers.scoreMultiplier;
    }
    
    domainScores[domain] = {
      rawScore,
      confidence: data.confidence,
      type: typeKey,
      data
    };
  }
  
  // Verifica se há algum domínio detectado
  const sorted = Object.entries(domainScores).sort((a, b) => b[1].rawScore - a[1].rawScore);
  
  const dominantEntry = sorted[0];
  
  // FIX: Trata caso de nenhum domínio detectado explicitamente
  if (!dominantEntry) {
    return {
      domain: null,
      score: 0,
      confidence: 0,
      type: null,
      allDomains: {},
      runnerUp: null,
      systemConfidence: 0
    };
  }
  
  const [dominantDomain, dominantData] = dominantEntry;
  const runnerUp = sorted[1] || null;
  
  // Calcula systemConfidence (normalizado pelo maxExpectedScore do domínio)
  const config = DOMAIN_CONFIG[dominantDomain];
  const systemConfidence = Math.min(1.0, dominantData.rawScore / config.maxExpectedScore);
  
  return {
    domain: dominantDomain,
    score: dominantData.rawScore,
    confidence: dominantData.confidence,
    systemConfidence,
    type: dominantData.type,
    allDomains: domainScores,
    runnerUp: runnerUp ? { domain: runnerUp[0], ...runnerUp[1] } : null
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// NÍVEL 2: DECISÃO DE AÇÃO
// ═════════════════════════════════════════════════════════════════════════════

function decideAction(domainResult, forceFlags) {
  // FORCE FLAGS - Override absoluto (executado PRIMEIRO)
  if (forceFlags.forceExplainFirst) {
    return { 
      action: 'AI', 
      domain: 'general', 
      reason: 'FORCE_EXPLAIN_FIRST',
      priority: 100 
    };
  }
  
  if (forceFlags.forceEmpathy) {
    return { 
      action: 'AI', 
      domain: 'general', 
      reason: 'FORCE_EMPATHY',
      priority: 100 
    };
  }
  
  if (forceFlags.forceRedirect) {
    return { 
      action: 'AI', 
      domain: 'general', 
      reason: 'FORCE_REDIRECT',
      priority: 100 
    };
  }
  
  if (forceFlags.forceUrgencia || forceFlags.forceUrgency) {
    return { 
      action: 'AI', 
      domain: 'urgency', 
      reason: 'FORCE_URGENCY',
      priority: 100 
    };
  }
  
  if (forceFlags.forceFirstContact) {
    return { 
      action: 'HYBRID', 
      domain: 'first_contact', 
      reason: 'FORCE_FIRST_CONTACT',
      priority: 95 
    };
  }
  
  // Force específicos por domínio
  if (forceFlags.forcePrice) {
    const config = DOMAIN_CONFIG.price;
    // Se tem dados de price, usa confidence deles
    const score = domainResult.domain === 'price' ? domainResult.score : 0.7; // default se não detectou
    
    if (score >= config.thresholds.RULE) {
      return { 
        action: 'RULE', 
        domain: 'price',
        reason: 'FORCE_PRICE_HIGH_CONF',
        priority: 90 
      };
    }
    return { 
      action: 'HYBRID', 
      domain: 'price',
      reason: 'FORCE_PRICE_MED_CONF',
      priority: 90 
    };
  }
  
  if (forceFlags.forceScheduling) {
    const config = DOMAIN_CONFIG.scheduling;
    const score = domainResult.domain === 'scheduling' ? domainResult.score : 0.7;
    
    if (score >= config.thresholds.RULE) {
      return { 
        action: 'RULE', 
        domain: 'scheduling',
        reason: 'FORCE_SCHEDULING_HIGH_CONF',
        priority: 90 
      };
    }
    return { 
      action: 'HYBRID', 
      domain: 'scheduling',
      reason: 'FORCE_SCHEDULING_MED_CONF',
      priority: 90 
    };
  }
  
  // SEM DOMÍNIO DETECTADO
  if (!domainResult.domain) {
    return { 
      action: 'AI', 
      domain: null,
      reason: 'NO_DOMAIN_DETECTED',
      priority: 0 
    };
  }
  
  // THRESHOLDS ESPECÍFICOS DO DOMÍNIO
  const config = DOMAIN_CONFIG[domainResult.domain];
  const { RULE, HYBRID } = config.thresholds;
  
  if (domainResult.score >= RULE) {
    return { 
      action: 'RULE', 
      reason: `${domainResult.domain.toUpperCase()}_HIGH_CONFIDENCE`,
      priority: domainResult.systemConfidence 
    };
  }
  
  if (domainResult.score >= HYBRID) {
    return { 
      action: 'HYBRID', 
      reason: `${domainResult.domain.toUpperCase()}_MEDIUM_CONFIDENCE`,
      priority: domainResult.systemConfidence 
    };
  }
  
  // FALLBACK PARA IA
  return { 
    action: 'AI', 
    reason: `${domainResult.domain.toUpperCase()}_LOW_CONFIDENCE`,
    priority: domainResult.systemConfidence 
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ENTRY POINT PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════

export function resolveDecision(inputs) {
  const startTime = Date.now();
  
  const {
    forceFlags = {},
    detectorResults = {},
    currentState = 'IDLE',
    messageIndex = 0,
    enrichedContext = {},
    businessRules = null, // 🆕 RNs aplicadas
    contextModifiers = null // 🆕 Modificadores de contexto
  } = inputs;
  
  // 🆕 VERIFICA BLOQUEIOS ABSOLUTOS DAS RNs
  if (businessRules?.shouldBlock) {
    logger.debug('DECISION_BLOCKED_BY_RULE', { reason: businessRules.blockReason });
    return {
      action: 'RULE',
      domain: 'system',
      reason: businessRules.blockReason,
      priority: 0,
      blockedByRule: true,
      meta: { timestamp: new Date().toISOString(), processingTimeMs: Date.now() - startTime }
    };
  }
  
  // Log entrada para debugging
  logger.debug('DECISION_START', {
    currentState,
    messageIndex,
    forceFlags: Object.keys(forceFlags).filter(k => forceFlags[k]),
    rulesMultiplier: contextModifiers?.scoreMultiplier
  });
  
  // ═════════════════════════════════════════════════════════════════════════
  // NÍVEL 1: Seleciona domínio dominante
  // ═════════════════════════════════════════════════════════════════════════
  
  const domainResult = selectDomain(detectorResults, {
    currentState,
    messageIndex,
    hasPendingSlots: enrichedContext?.lead?.pendingSchedulingSlots?.length > 0,
    ...enrichedContext
  }, contextModifiers);
  
  // ═════════════════════════════════════════════════════════════════════════
  // NÍVEL 2: Decide ação dentro do domínio
  // ═════════════════════════════════════════════════════════════════════════
  
  const actionResult = decideAction(domainResult, forceFlags);
  
  const processingTime = Date.now() - startTime;
  
  // ═════════════════════════════════════════════════════════════════════════
  // MONTA RESULTADO COMPLETO
  // ═════════════════════════════════════════════════════════════════════════
  
  const result = {
    // Decisão principal
    action: actionResult.action,        // 'RULE' | 'HYBRID' | 'AI'
    domain: actionResult.domain || domainResult.domain,  // domínio da ação
    
    // Scores (rawScore sem cortes + systemConfidence normalizado)
    score: domainResult.score,                    // rawScore ponderado
    confidence: domainResult.confidence,          // confidence base do detector
    systemConfidence: domainResult.systemConfidence, // 0-1 normalizado
    
    // Metadados para debugging/evolução
    reason: actionResult.reason,
    priority: actionResult.priority,
    
    // Contexto completo para próximas camadas
    context: {
      type: domainResult.type,
      currentState,
      messageIndex,
      runnerUp: domainResult.runnerUp,  // Segundo colocado (detecta ambiguidade?)
      allDomains: domainResult.allDomains,
      isAmbiguous: domainResult.runnerUp && 
        (domainResult.score - domainResult.runnerUp.rawScore) < 0.15,
      // 🆕 Contexto das RNs
      businessRules: businessRules ? {
        constraints: businessRules.constraints,
        modifiers: businessRules.scoreModifiers,
        context: businessRules.context
      } : null
    },
    
    // 🆕 Informações das RNs aplicadas
    rulesApplied: {
      multiplier: contextModifiers?.scoreMultiplier || 1.0,
      boostReasons: contextModifiers?.boostReasons || [],
      hasConstraints: (businessRules?.constraints?.length || 0) > 0
    },
    
    // Performance
    meta: {
      timestamp: new Date().toISOString(),
      version: '2.0',
      processingTimeMs: processingTime
    }
  };
  
  // Log saída
  logger.debug('DECISION_RESULT', {
    action: result.action,
    domain: result.domain,
    score: result.score.toFixed(3),
    systemConfidence: result.systemConfidence.toFixed(3),
    reason: result.reason,
    isAmbiguous: result.context.isAmbiguous
  });
  
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS PARA USO NO SISTEMA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extrai detectorResults das flags do DetectorAdapter
 */
export function extractDetectorResults(flags) {
  return {
    price: flags._price,
    scheduling: flags._scheduling,
    confirmation: flags._confirmation,
    insurance: flags._insurance
  };
}

/**
 * Verifica se há ambiguidade entre domínios (runner-up próximo)
 */
export function isAmbiguousDecision(decision, threshold = 0.15) {
  if (!decision.context.runnerUp) return false;
  const diff = decision.score - decision.context.runnerUp.rawScore;
  return diff < threshold;
}

/**
 * Retorna estatísticas do resolver para análise
 */
export function getResolverStats() {
  return {
    domains: Object.keys(DOMAIN_CONFIG),
    thresholds: Object.fromEntries(
      Object.entries(DOMAIN_CONFIG).map(([k, v]) => [k, v.thresholds])
    ),
    version: '2.0'
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// EXEMPLO DE USO (comentado)
// ═════════════════════════════════════════════════════════════════════════════

/*
// No AmandaOrchestrator.js ou WhatsAppOrchestrator.js:

import { resolveDecision, extractDetectorResults } from './decision/DecisionResolver.js';

// ... após detectWithContext ...
const flags = detectWithContext(text, lead, enrichedContext);

const decision = resolveDecision({
  forceFlags: context.forceFlags,
  detectorResults: extractDetectorResults(flags),
  currentState: lead.currentState || 'IDLE',
  messageIndex: enrichedContext?.conversationHistory?.filter(m => m.role === 'user').length || 0,
  enrichedContext
});

// Usa decision.action para rotear:
switch (decision.action) {
  case 'RULE':
    // Resposta 100% programática baseada no domínio
    return handleRuleResponse(decision.domain, decision.context);
    
  case 'HYBRID':
    // Estrutura programática + IA preenche gaps
    return handleHybridResponse(decision.domain, decision.context);
    
  case 'AI':
    // IA com contexto rico
    return callAIWithDecisionContext(decision);
}
*/

export default { 
  resolveDecision, 
  extractDetectorResults, 
  isAmbiguousDecision,
  getResolverStats,
  DOMAIN_CONFIG 
};
