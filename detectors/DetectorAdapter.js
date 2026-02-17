/**
 * 🔌 DETECTOR ADAPTER
 *
 * Adapter Pattern para integrar novos detectores contextuais com flagsDetector.js legacy.
 *
 * 🏗️ ARQUITETURA:
 * - Mantém compatibilidade com flagsDetector.js (deriveFlagsFromText)
 * - Enriquece flags com detecções contextuais (ConfirmationDetector, InsuranceDetector)
 * - Permite migração gradual sem quebrar o sistema
 * - Orchestrator continua usando flags + recebe dados estruturados extras
 *
 * 📊 IMPACTO:
 * - ConfirmationDetector (26.3%): Reduz erro em confirmações -40%
 * - InsuranceDetector (18.4%): Reduz insistência em plano -60%, +15-25pp conversão
 */

import ConfirmationDetector from './ConfirmationDetector.js';
import InsuranceDetector from './InsuranceDetector.js';
import PriceDetector from './PriceDetector.js';           // 🆕 FASE 2
import SchedulingDetector from './SchedulingDetector.js'; // 🆕 FASE 2
import { deriveFlagsFromText } from '../utils/flagsDetector.js';

/**
 * 🔍 DETECTA INTENTS COM NOVOS DETECTORES + LEGACY FLAGS
 *
 * @param {string} text - Mensagem do lead
 * @param {object} lead - Documento do lead do MongoDB
 * @param {object} enrichedContext - Contexto enriquecido (de leadContext.js)
 *
 * @returns {object} Flags legacy + detecções contextuais
 */
export function detectWithContext(text, lead = {}, enrichedContext = {}) {
  // 1️⃣ PEGA FLAGS LEGACY (mantém compatibilidade total)
  const legacyFlags = deriveFlagsFromText(text);

  // 2️⃣ MONTA CONTEXTO PARA DETECTORES CONTEXTUAIS
  const detectorContext = buildDetectorContext(lead, enrichedContext);

  // 3️⃣ RODA DETECTORES CONTEXTUAIS (FASE 1 + FASE 2)
  const confirmationDetection = ConfirmationDetector.detect(text, detectorContext);
  const insuranceDetection = InsuranceDetector.detect(text, detectorContext);
  const priceDetection = PriceDetector.detect(text, detectorContext);            // 🆕 FASE 2
  const schedulingDetection = SchedulingDetector.detect(text, detectorContext);  // 🆕 FASE 2

  // 4️⃣ ENRIQUECE FLAGS COM DETECÇÕES CONTEXTUAIS

  // 🎯 Confirmação contextual
  if (confirmationDetection?.detected) {
    // Mantém flag legacy (compatibilidade)
    legacyFlags.isConfirmation = true;

    // Adiciona dados contextuais ricos
    legacyFlags._confirmation = {
      semanticMeaning: confirmationDetection.semanticMeaning,
      confidence: confirmationDetection.confidence,
      requiresValidation: confirmationDetection.requiresValidation,
      type: confirmationDetection.confirmationType
    };

    // 🔥 DECISÃO CONTEXTUAL: Se confiança < 0.7, marca pra validação
    if (confirmationDetection.confidence < 0.7) {
      legacyFlags.needsConfirmationClarification = true;
    }

    // 🎯 Se inferiu aceite de slot, marca flag específica
    if (confirmationDetection.semanticMeaning === 'accept_slot') {
      legacyFlags.confirmsScheduling = true;
    }

    // 🎯 Se inferiu aceite de preço, marca flag específica
    if (confirmationDetection.semanticMeaning === 'accept_price') {
      legacyFlags.acceptsPrice = true;
    }

    // 🎯 Se inferiu aceite de plano, marca flag específica
    if (confirmationDetection.semanticMeaning === 'accept_plan') {
      legacyFlags.acceptsPlan = true;
    }
  }

  // 🏥 Plano de saúde contextual
  if (insuranceDetection?.detected) {
    // Mantém flag legacy (compatibilidade)
    legacyFlags.asksPlans = true;

    // Adiciona dados contextuais ricos
    legacyFlags._insurance = {
      plan: insuranceDetection.plan,
      planAliases: insuranceDetection.planAliases,
      intentType: insuranceDetection.intentType,
      confidence: insuranceDetection.confidence,
      isSpecific: insuranceDetection.isSpecific,
      isConfused: insuranceDetection.isConfused,  // 🆕 Absorve insurance_confusion pattern
      wisdomKey: insuranceDetection.wisdomKey  // Orchestrator pode usar clinicWisdom[wisdomKey]
    };

    // 🔥 FLAGS ESPECÍFICAS PARA PLANOS COMUNS
    if (insuranceDetection.plan === 'unimed') {
      legacyFlags.mentionsUnimed = true;
    }
    if (insuranceDetection.plan === 'ipasgo') {
      legacyFlags.mentionsIpasgo = true;
    }

    // 🎯 Tipo de intenção
    if (insuranceDetection.intentType === 'question') {
      legacyFlags.asksIfAcceptsPlan = true;
    } else if (insuranceDetection.intentType === 'statement') {
      legacyFlags.hasPlan = true;
    } else if (insuranceDetection.intentType === 'concern') {
      legacyFlags.worriesAboutPlan = true;
    } else if (insuranceDetection.intentType === 'confusion') {
      // 🆕 Flag para confusão sobre convênio (absorve pattern deprecated)
      legacyFlags.hasInsuranceConfusion = true;  // Orchestrator explica modalidade particular
    }

    // 🔥 Se perguntou sobre plano específico com alta confiança, reduz insistência
    if (insuranceDetection.isSpecific && insuranceDetection.confidence > 0.8) {
      legacyFlags.planQuestionAnswered = true;  // Orchestrator usa isso pra evitar repetir
    }
  }

  // 💰 FASE 2: Preço contextual
  if (priceDetection?.detected) {
    // Mantém flag legacy (compatibilidade)
    legacyFlags.asksPrice = true;

    // Adiciona dados contextuais ricos
    legacyFlags._price = {
      priceType: priceDetection.priceType,
      confidence: priceDetection.confidence,
      isInsistent: priceDetection.isInsistent,
      hasObjection: priceDetection.hasObjection,
      wantsNegotiation: priceDetection.wantsNegotiation,
      isEarlyQuestion: priceDetection.isEarlyQuestion  // 🆕 Absorve early_price_question pattern
    };

    // 🔥 FLAGS ESPECÍFICAS POR TIPO
    if (priceDetection.priceType === 'insistence') {
      legacyFlags.insistsPrice = true;
    }
    if (priceDetection.priceType === 'objection') {
      legacyFlags.mentionsPriceObjection = true;
    }
    if (priceDetection.priceType === 'negotiation') {
      legacyFlags.wantsNegotiation = true;
    }
    if (priceDetection.priceType === 'acceptance') {
      legacyFlags.acceptsPrice = true;
    }

    // 🆕 Flag para early price question (absorve pattern deprecated)
    if (priceDetection.isEarlyQuestion) {
      legacyFlags.asksEarlyPrice = true;  // Orchestrator pode valorizar antes de falar preço
    }
  }

  // 📅 FASE 2: Agendamento contextual
  if (schedulingDetection?.detected) {
    // Mantém flag legacy (compatibilidade)
    legacyFlags.wantsSchedule = true;

    // Adiciona dados contextuais ricos
    legacyFlags._scheduling = {
      schedulingType: schedulingDetection.schedulingType,
      preferredPeriod: schedulingDetection.preferredPeriod,
      hasUrgency: schedulingDetection.hasUrgency,
      confidence: schedulingDetection.confidence
    };

    // 🔥 FLAGS ESPECÍFICAS POR TIPO
    if (schedulingDetection.schedulingType === 'reschedule') {
      legacyFlags.wantsReschedule = true;
    }
    if (schedulingDetection.schedulingType === 'cancellation') {
      legacyFlags.wantsCancellation = true;
    }
    if (schedulingDetection.hasUrgency) {
      legacyFlags.mentionsUrgency = true;
    }

    // 🔥 FLAGS DE PERÍODO
    if (schedulingDetection.preferredPeriod === 'morning') {
      legacyFlags.prefersMorning = true;
    }
    if (schedulingDetection.preferredPeriod === 'afternoon') {
      legacyFlags.prefersAfternoon = true;
    }
  }

  // 5️⃣ RETORNA FLAGS ENRIQUECIDAS
  return {
    ...legacyFlags,

    // 📊 Metadados dos detectores (FASE 1 + FASE 2)
    _meta: {
      hasContextualDetection: !!(confirmationDetection || insuranceDetection || priceDetection || schedulingDetection),
      detectors: {
        confirmation: confirmationDetection ? 'active' : 'inactive',
        insurance: insuranceDetection ? 'active' : 'inactive',
        price: priceDetection ? 'active' : 'inactive',           // 🆕 FASE 2
        scheduling: schedulingDetection ? 'active' : 'inactive'  // 🆕 FASE 2
      },
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * 🏗️ CONSTRÓI CONTEXTO PARA DETECTORES CONTEXTUAIS
 */
function buildDetectorContext(lead, enrichedContext) {
  // 🔍 Extrai última mensagem da Amanda (para inferir contexto)
  const lastBotMessage = getLastBotMessage(enrichedContext.conversationHistory);

  // 🎯 Determina stage atual
  const stage = determineStage(lead, enrichedContext);

  // 📊 Calcula messageIndex (índice da mensagem inbound no histórico)
  const messageIndex = calculateMessageIndex(enrichedContext.conversationHistory);

  return {
    // Contexto da conversa
    lastBotMessage,
    stage,

    // Dados do lead (para decisões contextuais)
    leadData: {
      status: lead.status,
      therapyArea: lead.therapyArea,
      hasScheduling: !!lead.pendingSchedulingSlots,
      hasPendingSlot: !!lead.pendingChosenSlot
    },

    // Contexto de conversa
    messageCount: enrichedContext.messageCount || 0,
    isFirstContact: enrichedContext.isFirstContact || false,
    messageIndex,  // 🆕 Índice da mensagem inbound (0-based) para detecção de early questions

    // 🆕 FASE 2: Contexto de preço e agendamento
    priceAlreadyMentioned: !!(lastBotMessage && /R\$\s*\d+/i.test(lastBotMessage)),
    hasScheduling: !!lead.pendingSchedulingSlots || !!lead.pendingChosenSlot
  };
}

/**
 * 📊 CALCULA ÍNDICE DA MENSAGEM INBOUND (0-based)
 *
 * Conta quantas mensagens inbound (role: 'user') existem no histórico.
 * Usado por PriceDetector.isEarlyQuestion para detectar perguntas nas primeiras mensagens.
 *
 * @param {Array} conversationHistory - Histórico de mensagens
 * @returns {number} Índice da mensagem inbound (0-based)
 */
function calculateMessageIndex(conversationHistory = []) {
  if (!Array.isArray(conversationHistory)) {
    return 0;
  }

  // Conta mensagens inbound (role: 'user')
  const inboundCount = conversationHistory.filter(msg => msg?.role === 'user').length;

  // Retorna índice 0-based (se houver 3 mensagens, a atual é índice 2)
  return Math.max(0, inboundCount - 1);
}

/**
 * 🔍 EXTRAI ÚLTIMA MENSAGEM DO BOT (Amanda)
 */
function getLastBotMessage(conversationHistory = []) {
  if (!Array.isArray(conversationHistory)) {
    return null;
  }

  // Percorre do mais recente para o mais antigo
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg?.role === 'assistant' && msg?.content) {
      return msg.content;
    }
  }

  return null;
}

/**
 * 🎯 DETERMINA STAGE CONTEXTUAL
 */
function determineStage(lead, enrichedContext) {
  // 1. Se lead tem stage explícito, usa
  if (lead.stage) {
    // Mapeia stages do banco para categorias semânticas
    const stageMap = {
      'triagem_agendamento': 'scheduling',
      'agendado': 'scheduling',
      'qualificacao': 'qualification',
      'negociacao': 'pricing',
      'engajado': 'general',
      'novo': 'general',
      'paciente': 'general'
    };

    return stageMap[lead.stage] || 'general';
  }

  // 2. Infere do contexto
  if (lead.pendingSchedulingSlots || lead.pendingChosenSlot) {
    return 'scheduling';
  }

  if (lead.qualificationData?.intent === 'informacao_preco') {
    return 'pricing';
  }

  if (lead.qualificationData?.intent === 'consulta_convenio') {
    return 'insurance';
  }

  // 3. Default
  return 'general';
}

/**
 * 📊 ESTATÍSTICAS DOS DETECTORES (para debugging/admin)
 */
export function getDetectorStats() {
  return {
    fase1: {
      confirmation: ConfirmationDetector.getStats(),
      insurance: InsuranceDetector.getStats()
    },
    fase2: {
      price: PriceDetector.getStats(),
      scheduling: SchedulingDetector.getStats()
    }
  };
}

/**
 * 🧠 REGISTRA FEEDBACK (para learning futuro - Fase 4)
 */
export function addDetectorFeedback(type, text, wasCorrect, correctValue = null) {
  switch (type) {
    case 'confirmation':
      ConfirmationDetector.addFeedback(text, wasCorrect, correctValue);
      break;
    case 'insurance':
      InsuranceDetector.addFeedback(text, wasCorrect, correctValue);
      break;
    case 'price':                          // 🆕 FASE 2
      PriceDetector.addFeedback(text, wasCorrect, correctValue);
      break;
    case 'scheduling':                     // 🆕 FASE 2
      SchedulingDetector.addFeedback(text, wasCorrect, correctValue);
      break;
    default:
      console.warn(`[DETECTOR-ADAPTER] Tipo desconhecido: ${type}`);
  }
}

export default {
  detectWithContext,
  getDetectorStats,
  addDetectorFeedback
};
