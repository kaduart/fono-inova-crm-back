// services/intelligence/SuggestionService.js
// 🎯 SERVIÇO UNIFICADO DE SUGESTÕES

/**
 * Centraliza todas as sugestões de melhoria para evitar conflitos entre:
 * - Detectores contextuais (FASE 1,2)
 * - PatternRecognitionService (FASE 3)
 * - DetectorLearningService (FASE 4)
 *
 * 📊 PROBLEMA RESOLVIDO:
 * - Antes: Múltiplos sistemas gerando sugestões conflitantes
 * - Agora: Fonte única de verdade com priorização inteligente
 */

/**
 * 🎯 GERA SUGESTÕES CONSOLIDADAS
 *
 * @param {object} detection - Detecção de detector contextual
 * @param {string} detection.type - Tipo da detecção ('price_inquiry', 'insurance_inquiry', etc)
 * @param {object} patterns - Padrões do PatternRecognitionService
 * @param {object} detectorAnalysis - Análise do DetectorLearningService (opcional)
 *
 * @returns {object} Sugestões consolidadas e priorizadas
 */
export function generateConsolidatedSuggestions(detection, patterns = {}, detectorAnalysis = null) {
  const suggestions = {
    primary: null,        // Sugestão principal
    secondary: [],        // Sugestões secundárias
    warnings: [],         // Avisos importantes
    source: null,         // Fonte da sugestão ('detector', 'pattern', 'learning')
    priority: 'medium',   // 'low', 'medium', 'high', 'critical'
    confidence: 0         // 0.0 - 1.0
  };

  // 🔍 PRIORIDADE 1: Detectores contextuais (mais precisos)
  if (detection?.detected) {
    const detectorSuggestion = getDetectorSuggestion(detection);
    if (detectorSuggestion) {
      suggestions.primary = detectorSuggestion.text;
      suggestions.source = 'detector';
      suggestions.priority = detectorSuggestion.priority;
      suggestions.confidence = detection.confidence || 0.7;
      return suggestions;
    }
  }

  // 🔍 PRIORIDADE 2: Padrões reconhecidos (histórico)
  if (patterns?.problems?.length > 0) {
    // Filtra padrões deprecated
    const activePatterns = patterns.problems.filter(p => !p.isDeprecated);

    if (activePatterns.length > 0) {
      // Ordena por severity
      const criticalPatterns = activePatterns.filter(p => p.severity === 'critical');
      const targetPattern = criticalPatterns.length > 0 ? criticalPatterns[0] : activePatterns[0];

      suggestions.primary = targetPattern.suggestion;
      suggestions.source = 'pattern';
      suggestions.priority = targetPattern.severity === 'critical' ? 'critical' : 'high';
      suggestions.confidence = 0.6;

      // Adiciona padrões deprecated como avisos
      const deprecatedPatterns = patterns.problems.filter(p => p.isDeprecated);
      if (deprecatedPatterns.length > 0) {
        suggestions.warnings.push({
          type: 'deprecated_pattern',
          message: `${deprecatedPatterns.length} padrão(ões) deprecated detectado(s)`,
          patterns: deprecatedPatterns.map(p => ({
            key: p.key,
            replacedBy: p.deprecationInfo?.replacedBy
          }))
        });
      }

      return suggestions;
    }
  }

  // 🔍 PRIORIDADE 3: Análise de learning (FASE 4)
  if (detectorAnalysis?.newPatternsDiscovered?.length > 0) {
    suggestions.primary = 'Novos padrões descobertos - considere atualizar detectores';
    suggestions.source = 'learning';
    suggestions.priority = 'low';
    suggestions.confidence = 0.5;
    suggestions.secondary = detectorAnalysis.newPatternsDiscovered.map(p => p.example);
  }

  // Default: sem sugestões
  if (!suggestions.primary) {
    suggestions.primary = 'Sistema funcionando normalmente';
    suggestions.source = 'default';
    suggestions.priority = 'low';
    suggestions.confidence = 1.0;
  }

  return suggestions;
}

/**
 * 🎯 GERA SUGESTÃO ESPECÍFICA DE DETECTOR
 */
function getDetectorSuggestion(detection) {
  switch (detection.type) {
    case 'price_inquiry':
      return getPriceSuggestion(detection);

    case 'insurance_inquiry':
      return getInsuranceSuggestion(detection);

    case 'scheduling_inquiry':
      return getSchedulingSuggestion(detection);

    case 'confirmation':
      return getConfirmationSuggestion(detection);

    default:
      return null;
  }
}

/**
 * 💰 SUGESTÃO PARA PRICE DETECTOR
 */
function getPriceSuggestion(detection) {
  // Early price question tem prioridade máxima
  if (detection.isEarlyQuestion) {
    return {
      text: 'Lead perguntou preço muito cedo (primeiras 2-3 mensagens). VALORIZAR terapia antes de falar valor.',
      priority: 'high',
      action: 'contextualize_before_price'
    };
  }

  // Objeção de preço
  if (detection.hasObjection) {
    return {
      text: 'Lead tem objeção de preço. Oferecer parcelamento, destacar benefícios.',
      priority: 'high',
      action: 'handle_price_objection'
    };
  }

  // Negociação
  if (detection.wantsNegotiation) {
    return {
      text: 'Lead quer negociar. Explicar opções de pagamento.',
      priority: 'medium',
      action: 'explain_payment_options'
    };
  }

  // Insistência (sem ser early)
  if (detection.isInsistent) {
    return {
      text: 'Lead insiste em preço. Falar valor, mas contextualizar benefícios.',
      priority: 'medium',
      action: 'provide_price_with_context'
    };
  }

  // Genérico
  return {
    text: 'Pergunta sobre preço. Responder de forma contextualizada.',
    priority: 'low',
    action: 'answer_price_question'
  };
}

/**
 * 🏥 SUGESTÃO PARA INSURANCE DETECTOR
 */
function getInsuranceSuggestion(detection) {
  // Confusão sobre convênio
  if (detection.isConfused) {
    return {
      text: 'Lead confuso sobre modalidade. EXPLICAR: particular com possibilidade de reembolso.',
      priority: 'high',
      action: 'clarify_insurance_modality'
    };
  }

  // Pergunta sobre plano específico
  if (detection.isSpecific && detection.intentType === 'question') {
    return {
      text: `Lead perguntou sobre ${detection.plan}. Explicar que é particular com reembolso.`,
      priority: 'medium',
      action: 'explain_specific_plan'
    };
  }

  // Lead tem plano
  if (detection.intentType === 'statement') {
    return {
      text: 'Lead informou que tem plano. Orientar sobre reembolso.',
      priority: 'medium',
      action: 'guide_reimbursement'
    };
  }

  // Preocupação com plano
  if (detection.intentType === 'concern') {
    return {
      text: 'Lead preocupado com plano. Tranquilizar sobre reembolso.',
      priority: 'medium',
      action: 'reassure_about_plan'
    };
  }

  // Genérico
  return {
    text: 'Pergunta sobre convênio. Explicar modalidade particular.',
    priority: 'low',
    action: 'answer_insurance_question'
  };
}

/**
 * 📅 SUGESTÃO PARA SCHEDULING DETECTOR
 */
function getSchedulingSuggestion(detection) {
  // Cancelamento
  if (detection.schedulingType === 'cancellation') {
    return {
      text: 'CRÍTICO: Lead quer cancelar. Oferecer reagendamento flexível.',
      priority: 'critical',
      action: 'offer_flexible_reschedule'
    };
  }

  // Urgência
  if (detection.hasUrgency) {
    return {
      text: 'Lead tem urgência. Priorizar slots mais próximos.',
      priority: 'high',
      action: 'prioritize_urgent_slots'
    };
  }

  // Remarcação
  if (detection.schedulingType === 'reschedule') {
    return {
      text: 'Lead quer remarcar. Oferecer novos slots.',
      priority: 'medium',
      action: 'offer_reschedule_slots'
    };
  }

  // Preferência de período
  if (detection.preferredPeriod && detection.preferredPeriod !== 'flexible') {
    return {
      text: `Lead prefere ${detection.preferredPeriod === 'morning' ? 'manhã' : 'tarde'}. Filtrar slots.`,
      priority: 'medium',
      action: 'filter_by_period'
    };
  }

  // Genérico
  return {
    text: 'Solicitação de agendamento. Oferecer slots disponíveis.',
    priority: 'low',
    action: 'offer_slots'
  };
}

/**
 * ✅ SUGESTÃO PARA CONFIRMATION DETECTOR
 */
function getConfirmationSuggestion(detection) {
  // Confirmação com baixa confiança
  if (detection.confidence < 0.7) {
    return {
      text: 'Confirmação ambígua. VALIDAR com pergunta direta.',
      priority: 'high',
      action: 'validate_confirmation'
    };
  }

  // Confirmação de agendamento
  if (detection.semanticMeaning === 'accept_slot') {
    return {
      text: 'Lead aceitou slot. Finalizar agendamento.',
      priority: 'medium',
      action: 'finalize_booking'
    };
  }

  // Confirmação de preço
  if (detection.semanticMeaning === 'accept_price') {
    return {
      text: 'Lead aceitou preço. Avançar para agendamento.',
      priority: 'medium',
      action: 'proceed_to_scheduling'
    };
  }

  // Genérico
  return {
    text: 'Confirmação detectada. Prosseguir conforme contexto.',
    priority: 'low',
    action: 'proceed'
  };
}

/**
 * 📊 CONSOLIDA MÚLTIPLAS SUGESTÕES
 *
 * Útil quando múltiplos detectores são acionados simultaneamente.
 */
export function mergeMultipleSuggestions(suggestionsList = []) {
  if (suggestionsList.length === 0) {
    return null;
  }

  if (suggestionsList.length === 1) {
    return suggestionsList[0];
  }

  // Ordena por prioridade
  const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
  const sorted = suggestionsList.sort((a, b) =>
    priorityOrder[b.priority] - priorityOrder[a.priority]
  );

  // Pega sugestão de maior prioridade como primária
  const merged = { ...sorted[0] };

  // Adiciona demais como secundárias
  merged.secondary = sorted.slice(1).map(s => s.primary);

  return merged;
}

/**
 * 🔍 BUSCA SUGESTÕES HISTÓRICAS (útil para debugging)
 */
export async function getHistoricalSuggestions(leadId, limit = 10) {
  // TODO: Implementar busca no MongoDB quando necessário
  // Por ora, retorna vazio
  return [];
}

export default {
  generateConsolidatedSuggestions,
  mergeMultipleSuggestions,
  getHistoricalSuggestions
};
