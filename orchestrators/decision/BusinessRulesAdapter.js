/**
 * 🏛️ BUSINESS RULES ADAPTER v2.0
 * 
 * Integra 83+ RNs do Amanda ao DecisionResolver
 * Organizado em: Constraints | Modifiers | Context
 * 
 * @version 2.0
 * @date 2026-04-04
 */

import Logger from '../../services/utils/Logger.js';
import { isBusinessHours } from '../../utils/businessHours.js';

const logger = new Logger('BusinessRulesAdapter');

// ═════════════════════════════════════════════════════════════════════════════
// 🧱 1. HARD CONSTRAINTS (Bloqueios Absolutos - Prioridade 0)
// ═════════════════════════════════════════════════════════════════════════════

const HARD_CONSTRAINTS = {
  
  /**
   * RN-001: Horário comercial
   * 🟢 DESATIVADO: Amanda agora trabalha 24/7!
   * A IA responde automaticamente em qualquer horário.
   */
  operatingHours: (input) => {
    // Regra desativada - IA Amanda trabalha 24h por dia, 7 dias por semana
    return { active: false };
  },

  /**
   * RN-002: Rate limiting por lead
   * Anti-spam: intervalo mínimo entre mensagens
   */
  rateLimit: (input) => {
    const { lastMessageTime, minIntervalMs = 30000 } = input;
    
    if (!lastMessageTime) return { active: false };
    
    const timeSinceLast = Date.now() - new Date(lastMessageTime).getTime();
    if (timeSinceLast < minIntervalMs) {
      return {
        active: true,
        type: 'CONSTRAINT',
        reason: 'RATE_LIMITED',
        action: 'SILENT_DROP',
        priority: 0,
        cooldownRemaining: minIntervalMs - timeSinceLast
      };
    }
    return { active: false };
  },

  /**
   * RN-003: Lead blacklisted
   */
  blacklist: (input) => {
    const { lead } = input;
    
    if (lead?.flags?.includes('blacklisted') || lead?.status === 'bloqueado') {
      return {
        active: true,
        type: 'CONSTRAINT',
        reason: 'LEAD_BLACKLISTED',
        action: 'DROP_SILENTLY',
        priority: 0
      };
    }
    return { active: false };
  },

  /**
   * RN-004: Serviço indisponível
   */
  serviceAvailability: (input) => {
    const { requestedService, validServices = {} } = input;
    
    if (requestedService && !validServices[requestedService]) {
      return {
        active: true,
        type: 'CONSTRAINT',
        reason: 'SERVICE_UNAVAILABLE',
        action: 'REDIRECT',
        priority: 0.9,
        suggestedAlternative: validServices[requestedService]?.redirectTo || null
      };
    }
    return { active: false };
  },

  /**
   * RN-005: Limite de idade por terapia
   */
  ageLimit: (input) => {
    const { therapy, age } = input;
    
    // Psicologia: até 16 anos
    if (therapy === 'psicologia' && age > 16) {
      return {
        active: true,
        type: 'CONSTRAINT',
        reason: 'AGE_LIMIT_PSICO',
        action: 'BLOCK',
        priority: 0.9,
        message: 'Psicologia atende apenas até 16 anos. Para adultos, recomendamos Neuropsicologia 💚'
      };
    }
    
    // Neuropsicologia: a partir de 2 anos
    if (therapy === 'neuropsicologia' && age < 2) {
      return {
        active: true,
        type: 'CONSTRAINT',
        reason: 'AGE_LIMIT_NEURO',
        action: 'BLOCK',
        priority: 0.9,
        message: 'Neuropsicologia atende a partir de 2 anos. Para bebês, recomendamos outras especialidades 💚'
      };
    }
    
    return { active: false };
  },

  /**
   * RN-006: Double-booking prevention
   */
  doubleBooking: (input) => {
    const { lead, requestedSlot } = input;
    
    if (!requestedSlot || !lead?._id) return { active: false };
    
    // Verificação seria consultaria o banco
    // Stub: assume sem conflito para não bloquear
    return { active: false };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ⚖️ 2. SCORE MODIFIERS (Ajustes de Peso - Influenciam decisão)
// ═════════════════════════════════════════════════════════════════════════════

const SCORE_MODIFIERS = {
  
  /**
   * RN-101: Lead quente (alto engajamento)
   * Aumenta score de agendamento
   */
  hotLeadBoost: (input) => {
    const { lead } = input;
    if (!lead) return { multiplier: 1.0 };
    
    const isHot = lead.stage === 'engajado' || 
                  lead.engagementScore > 70 ||
                  lead.bookingOffersCount > 0;
    
    if (isHot) {
      return { 
        multiplier: 1.2, 
        reason: 'HOT_LEAD_BOOST',
        boostAmount: 0.2
      };
    }
    return { multiplier: 1.0 };
  },

  /**
   * RN-102: Lead novo (primeiras interações)
   * Reduz confiança em decisões automáticas
   */
  newLeadPenalty: (input) => {
    const { messageIndex = 0 } = input;
    
    if (messageIndex <= 2) {
      return {
        multiplier: 0.9,
        reason: 'NEW_LEAD_PENALTY',
        penaltyAmount: 0.1
      };
    }
    return { multiplier: 1.0 };
  },

  /**
   * RN-103: Urgência temporal detectada
   * Aumenta prioridade de agendamento
   */
  urgentRequestBoost: (input) => {
    const { text = '' } = input;
    
    const isUrgent = /\b(hoje|amanh[ãa]|urgente|emerg[eê]ncia|desesperad[oa]?|preciso\s+logo)\b/i.test(text);
    
    if (isUrgent) {
      return {
        multiplier: 1.25,
        reason: 'URGENT_REQUEST_BOOST',
        boostAmount: 0.25
      };
    }
    return { multiplier: 1.0 };
  },

  /**
   * RN-104: Histórico de objeção de preço
   * Aumenta score de price domain
   */
  priceObjectionHistory: (input) => {
    const { lead } = input;
    
    if (lead?.flags?.includes('price_objection')) {
      return {
        multiplier: 1.15,
        reason: 'PRICE_OBJECTION_HISTORY',
        boostAmount: 0.15
      };
    }
    return { multiplier: 1.0 };
  },

  /**
   * RN-105: Triagem incompleta
   * Reduz confiança em agendamento automático
   */
  incompleteTriagePenalty: (input) => {
    const { lead } = input;
    if (!lead) return { multiplier: 1.0 };
    
    const hasName = !!lead.patientInfo?.fullName;
    const hasAge = lead.patientInfo?.age != null;
    const hasComplaint = !!lead.complaint;
    
    const missingFields = [!hasName, !hasAge, !hasComplaint].filter(Boolean).length;
    
    if (missingFields > 1) {
      return {
        multiplier: 0.85,
        reason: 'INCOMPLETE_TRIAGE_PENALTY',
        penaltyAmount: 0.15 * missingFields
      };
    }
    return { multiplier: 1.0 };
  },

  /**
   * RN-106: Follow-up recente
   * Aumenta prioridade de resposta
   */
  recentFollowupBoost: (input) => {
    const { lead } = input;
    
    if (!lead?.lastFollowupAt) return { multiplier: 1.0 };
    
    const hoursSinceFollowup = (Date.now() - new Date(lead.lastFollowupAt).getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceFollowup < 24) {
      return {
        multiplier: 1.1,
        reason: 'RECENT_FOLLOWUP_BOOST',
        boostAmount: 0.1
      };
    }
    return { multiplier: 1.0 };
  },

  /**
   * RN-107: Slot pendente de confirmação
   * Aumenta score de confirmation domain
   */
  pendingSlotBoost: (input) => {
    const { lead } = input;
    
    if (lead?.pendingSchedulingSlots?.length > 0) {
      return {
        multiplier: 1.2,
        reason: 'PENDING_SLOT_BOOST',
        boostAmount: 0.2
      };
    }
    return { multiplier: 1.0 };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// 🧠 3. CONTEXT PROVIDERS (Informações Estratégicas)
// ═════════════════════════════════════════════════════════════════════════════

const CONTEXT_PROVIDERS = {
  
  /**
   * RN-201: Temperatura do lead
   */
  leadTemperature: (input) => {
    const { lead } = input;
    
    if (!lead) return { temperature: 'unknown' };
    
    const daysSinceContact = lead.lastContactAt 
      ? (Date.now() - new Date(lead.lastContactAt).getTime()) / (1000 * 60 * 60 * 24)
      : 999;
    
    if (lead.stage === 'paciente' || lead.status === 'agendado') {
      return { temperature: 'converted', daysSinceContact };
    }
    if (daysSinceContact < 1) return { temperature: 'hot', daysSinceContact };
    if (daysSinceContact < 7) return { temperature: 'warm', daysSinceContact };
    return { temperature: 'cold', daysSinceContact };
  },

  /**
   * RN-202: Nível de incerteza da mensagem
   */
  uncertaintyLevel: (input) => {
    const { text = '' } = input;
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    
    if (wordCount > 50) return { level: 'high', wordCount, context: 'detailed_explanation' };
    if (wordCount > 20) return { level: 'medium', wordCount, context: 'moderate_detail' };
    return { level: 'low', wordCount, context: 'brief_message' };
  },

  /**
   * RN-203: Primeiro contato
   */
  isFirstContact: (input) => {
    const { messageIndex = 0 } = input;
    return { 
      isFirst: messageIndex <= 1,
      messageIndex 
    };
  },

  /**
   * RN-204: Slots pendentes
   */
  schedulingContext: (input) => {
    const { lead } = input;
    
    return {
      hasPendingSlots: !!lead?.pendingSchedulingSlots?.length,
      pendingSlotCount: lead?.pendingSchedulingSlots?.length || 0,
      isAwaitingConfirmation: !!lead?.pendingChosenSlot,
      awaitingDataStep: lead?.pendingPatientInfoStep || null,
      context: lead?.pendingSchedulingSlots?.length > 0 
        ? 'awaiting_slot_selection' 
        : 'no_pending_slots'
    };
  },

  /**
   * RN-205: Mensagem duplicada
   */
  duplicateMessage: (input) => {
    const { text, lead } = input;
    
    if (!lead?.lastMessageText || !text) {
      return { isDuplicate: false, similarity: 0 };
    }
    
    const similarity = calculateSimilarity(text, lead.lastMessageText);
    return { 
      isDuplicate: similarity > 0.9, 
      similarity,
      context: similarity > 0.9 ? 'possible_duplicate' : 'new_message'
    };
  },

  /**
   * RN-206: Resposta de eco (rápida após bot)
   */
  echoResponse: (input) => {
    const { lead } = input;
    
    if (!lead?.lastBotMessageAt) return { isEcho: false };
    
    const timeSinceBot = Date.now() - new Date(lead.lastBotMessageAt).getTime();
    const isQuick = timeSinceBot < 60000; // 1 minuto
    
    return { 
      isEcho: isQuick,
      timeSinceBot,
      context: isQuick ? 'possible_echo' : 'normal_response'
    };
  },

  /**
   * RN-207: Dados da triagem
   */
  triageStatus: (input) => {
    const { lead } = input;
    
    if (!lead) {
      return { isComplete: false, missing: ['all'] };
    }
    
    const hasArea = !!lead.therapyArea;
    const hasComplaint = !!(lead.complaint || lead.primaryComplaint);
    const hasName = !!(lead.patientInfo?.fullName || lead.patientInfo?.name);
    const hasBirthDate = !!lead.patientInfo?.birthDate;
    const hasAge = lead.patientInfo?.age !== undefined && lead.patientInfo?.age !== null;
    const hasPeriod = !!(lead.pendingPreferredPeriod || lead.qualificationData?.disponibilidade);
    
    const missing = [];
    if (!hasArea) missing.push('therapyArea');
    if (!hasComplaint) missing.push('complaint');
    if (!hasName) missing.push('name');
    if (!hasBirthDate) missing.push('birthDate');
    if (!hasAge) missing.push('age');
    if (!hasPeriod) missing.push('period');
    
    return {
      isComplete: missing.length === 0,
      hasArea,
      hasComplaint,
      hasName,
      hasBirthDate,
      hasAge,
      hasPeriod,
      missing,
      completionRate: (6 - missing.length) / 6
    };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// 🔧 HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  if (s1 === s2) return 1.0;
  
  // Jaccard similarity
  const set1 = new Set(s1.split(/\s+/));
  const set2 = new Set(s2.split(/\s+/));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

// ═════════════════════════════════════════════════════════════════════════════
// 🎯 ENTRY POINT PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════

export function applyBusinessRules(input) {
  const startTime = Date.now();
  
  const result = {
    constraints: [],
    modifiers: [],
    context: {},
    shouldBlock: false,
    blockReason: null,
    finalMultiplier: 1.0
  };

  // 1. Aplicar HARD CONSTRAINTS
  for (const [name, fn] of Object.entries(HARD_CONSTRAINTS)) {
    try {
      const constraint = fn(input);
      if (constraint.active) {
        result.constraints.push({ name, ...constraint });
        
        if (constraint.priority === 0) {
          result.shouldBlock = true;
          result.blockReason = constraint.reason;
        }
      }
    } catch (err) {
      logger.warn(`[BusinessRules] Erro em constraint ${name}:`, err.message);
    }
  }

  // Se tem bloqueio absoluto, retorna early
  if (result.shouldBlock) {
    return {
      ...result,
      processingTimeMs: Date.now() - startTime
    };
  }

  // 2. Aplicar SCORE MODIFIERS
  let totalMultiplier = 1.0;
  for (const [name, fn] of Object.entries(SCORE_MODIFIERS)) {
    try {
      const modifier = fn(input);
      if (modifier.multiplier !== 1.0) {
        result.modifiers.push({ name, ...modifier });
        totalMultiplier *= modifier.multiplier;
      }
    } catch (err) {
      logger.warn(`[BusinessRules] Erro em modifier ${name}:`, err.message);
    }
  }
  result.finalMultiplier = Math.max(0.5, Math.min(2.0, totalMultiplier));

  // 3. Aplicar CONTEXT PROVIDERS
  for (const [name, fn] of Object.entries(CONTEXT_PROVIDERS)) {
    try {
      result.context[name] = fn(input);
    } catch (err) {
      logger.warn(`[BusinessRules] Erro em context ${name}:`, err.message);
      result.context[name] = { error: err.message };
    }
  }

  result.processingTimeMs = Date.now() - startTime;
  
  logger.debug('[BusinessRules] Applied', {
    constraints: result.constraints.length,
    modifiers: result.modifiers.length,
    finalMultiplier: result.finalMultiplier.toFixed(3)
  });

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// 🔥 INTEGRAÇÃO COM DECISION RESOLVER
// ═════════════════════════════════════════════════════════════════════════════

export function enrichInputWithBusinessRules(baseInput) {
  const rulesResult = applyBusinessRules(baseInput);
  
  // Se há bloqueio absoluto, retorna decisão forçada
  if (rulesResult.shouldBlock) {
    const blockingConstraint = rulesResult.constraints.find(c => c.priority === 0);
    return {
      ...baseInput,
      businessRules: rulesResult,
      forcedDecision: {
        action: 'RULE',
        domain: 'system',
        reason: rulesResult.blockReason,
        priority: 0,
        shouldBlock: true,
        message: blockingConstraint?.message || 'Processando...'
      }
    };
  }
  
  return {
    ...baseInput,
    businessRules: rulesResult,
    contextModifiers: {
      scoreMultiplier: rulesResult.finalMultiplier,
      boostReasons: rulesResult.modifiers.map(m => m.reason),
      constraints: rulesResult.constraints
    }
  };
}

// Exportações para testes e extensão
export { HARD_CONSTRAINTS, SCORE_MODIFIERS, CONTEXT_PROVIDERS };
export default { applyBusinessRules, enrichInputWithBusinessRules };
