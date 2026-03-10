// services/ResponseEnricher.js
// Camada de enriquecimento de respostas - FSM Inteligente com Contexto
// NÃO decide o que fazer (FSM faz isso), apenas ENRIQUECE COMO dizer

import Logger from './utils/Logger.js';
import { perceptionService } from '../perception/PerceptionService.js';

const logger = new Logger('ResponseEnricher');

/**
 * Níveis de enriquecimento
 * - NONE: Template puro (mais rápido, 100% determinístico)
 * - LIGHT: Template + variáveis dinâmicas (nome, idade, contexto)
 * - FULL: IA com contexto completo (para casos emocionais/complexos)
 */
export const ENRICHMENT_LEVEL = {
  NONE: 'none',    // Fluxos operacionais simples
  LIGHT: 'light',  // Personalização leve com flags
  FULL: 'full'     // IA para casos complexos
};

/**
 * Decide o nível de enriquecimento baseado nas flags e estado
 */
export function decideEnrichmentLevel(flags, state, lead) {
  // Sempre FULL para casos emocionais ou objeções complexas
  if (flags.isEmotional || flags.mentionsDoubtTEA) {
    return ENRICHMENT_LEVEL.FULL;
  }
  
  // FULL para objeções de preço ou concorrência
  if (flags.mentionsPriceObjection || flags.mentionsOtherClinicObjection) {
    return ENRICHMENT_LEVEL.FULL;
  }
  
  // LIGHT para hot leads (personalizar com nome, agilidade)
  if (flags.isHotLead || flags.wantsFastSolution) {
    return ENRICHMENT_LEVEL.LIGHT;
  }
  
  // LIGHT para retornos (contexto histórico)
  if (state === 'RETURNING' || lead?.messageCount > 5) {
    return ENRICHMENT_LEVEL.LIGHT;
  }
  
  // NONE para fluxos operacionais puros
  return ENRICHMENT_LEVEL.NONE;
}

/**
 * Enriquece uma resposta template baseada nas flags
 */
export function enrichTemplate(template, flags, lead, stateData = {}) {
  let enriched = template;
  
  // Substituições básicas
  const name = stateData.patientName || lead?.patientName;
  const age = stateData.age || lead?.patientAge;
  const therapy = stateData.therapy || lead?.therapyArea;
  
  if (name) {
    enriched = enriched.replace(/\*nome\*/g, name);
  }
  if (age) {
    enriched = enriched.replace(/\*idade\*/g, `${age} anos`);
  }
  if (therapy) {
    enriched = enriched.replace(/\*terapia\*/g, therapy);
  }
  
  // Adiciona acolhimento emocional se necessário
  if (flags.isEmotional && !enriched.includes('💚')) {
    enriched = `Entendo que você está preocupad${lead?.patientGender === 'F' ? 'a' : 'o'}. 💚\n\n${enriched}`;
  }
  
  // Adiciona urgência se solicitado
  if (flags.wantsFastSolution && !enriched.includes('urgente')) {
    enriched = enriched.replace(/💚/, '💚 Vou priorizar para você:');
  }
  
  return enriched;
}

/**
 * Gera resposta completa com IA quando necessário
 */
export async function generateRichResponse({
  text,
  lead,
  state,
  stateData,
  baseTemplate,
  flags
}) {
  const level = decideEnrichmentLevel(flags, state, lead);
  
  logger.debug('ENRICHMENT_DECISION', {
    leadId: lead?._id,
    state,
    level,
    flags: Object.keys(flags).filter(k => flags[k] === true)
  });
  
  switch (level) {
    case ENRICHMENT_LEVEL.NONE:
      // Template puro, apenas substituições básicas
      return enrichTemplate(baseTemplate, flags, lead, stateData);
      
    case ENRICHMENT_LEVEL.LIGHT:
      // Template enriquecido com flags
      return enrichTemplate(baseTemplate, flags, lead, stateData);
      
    case ENRICHMENT_LEVEL.FULL:
      // IA com contexto completo
      try {
        const context = buildContextForAI({ flags, lead, state, stateData, text });
        const perception = await perceptionService.analyze(text, lead, context);
        
        // Usa template como base mas permite IA ajustar tom
        return await enhanceWithAI(baseTemplate, perception, context);
      } catch (e) {
        logger.warn('AI_ENRICHMENT_FAILED', { error: e.message });
        // Fallback para template enriquecido
        return enrichTemplate(baseTemplate, flags, lead, stateData);
      }
      
    default:
      return baseTemplate;
  }
}

/**
 * Constrói contexto rico para a IA
 */
function buildContextForAI({ flags, lead, state, stateData, text }) {
  return {
    // Flags detectadas
    flags: Object.entries(flags)
      .filter(([_, v]) => v === true)
      .map(([k]) => k),
    
    // Estado atual da FSM
    fsmState: state,
    fsmData: stateData,
    
    // Histórico do lead
    leadProfile: {
      therapyArea: lead?.therapyArea,
      patientAge: lead?.patientAge,
      patientName: lead?.patientName,
      messageCount: lead?.messageCount,
      lastInteractionAt: lead?.lastInteractionAt
    },
    
    // Contexto da mensagem atual
    currentMessage: text,
    
    // Políticas da clínica (para compliance)
    policies: {
      neverPromiseCure: true,
      alwaysRequestAge: true,
      requireTriage: true,
      mentionReimbursement: flags.asksPlans || flags.mentionsReembolso
    }
  };
}

/**
 * Melhora resposta com IA mantendo compliance
 */
async function enhanceWithAI(baseTemplate, perception, context) {
  // TODO: Implementar chamada real para IA quando tivermos o serviço configurado
  // Por enquanto, faz enriquecimento avançado com as flags
  
  let enhanced = baseTemplate;
  const flags = context.flags || [];
  
  // Ajustes baseados em flags emocionais
  if (flags.includes('isEmotional')) {
    enhanced = enhanced.replace(
      /^(Oi!|Ol[aá]!)/i,
      'Oi! 💚 Sei que pode ser um momento difícil, mas estou aqui para te ajudar.'
    );
  }
  
  if (flags.includes('mentionsDoubtTEA')) {
    enhanced = enhanced.replace(
      /me conta um pouco da situação/i,
      'cada criança tem seu tempo, e é normal ter dúvidas. Me conta o que você tem observado?'
    );
  }
  
  return enhanced;
}

export default {
  decideEnrichmentLevel,
  enrichTemplate,
  generateRichResponse,
  ENRICHMENT_LEVEL
};
