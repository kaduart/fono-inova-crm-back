/**
 * 🎓 Real World Training Config
 * 
 * Configurações baseadas em casos reais para aprendizado contínuo.
 * Atualizado automaticamente pela análise de conversas.
 */

export const REAL_WORLD_PATTERNS = {
  // Padrões que devem ACIONAR o SmartFallback
  FALLBACK_TRIGGERS: [
    {
      pattern: /^(ok|sim|não|ta|tá|bom|boa|pode)$/i,
      context: 'short_reply_after_question',
      action: 'interpret_with_context'
    },
    {
      pattern: /(dois filhos|duas crianças|meus filhos|os dois|as duas)/i,
      context: 'multiple_children_detected',
      action: 'apply_family_discount'
    },
    {
      pattern: /(gripou|doente|doença|tosse|febre)/i,
      context: 'child_sick',
      action: 'reschedule_with_waiver'
    },
    {
      pattern: /(não recebi|não tenho dinheiro|mãe não pagou|ainda não posso)/i,
      context: 'financial_delay',
      action: 'offer_reschedule_no_fee'
    },
    {
      pattern: /(confundiu|dia errado|horário errado|achei que era)/i,
      context: 'schedule_confusion',
      action: 'clarify_and_confirm'
    }
  ],

  // Padrões que NÃO devem ser salvos como complaint
  NOT_COMPLAINT: [
    /(aceitam?|tem|fazem?).*?(plano|convênio|unimed|amil|hapvida|bradesco)/i,
    /(quanto custa|qual o valor|preço da avaliação|valor da sessão)/i,
    /(onde fica|endereço|como chegar|estacionamento)/i,
    /(funciona quando|horário de atendimento|dias da semana)/i,
    /(vocês são de onde|de qual cidade|qual o bairro)/i
  ],

  // Padrões que indicam especialidade correta
  SPECIALTY_DETECTION: [
    {
      pattern: /(dificuldade na escola|não sabe ler|não sabe escrever|problema de aprendizagem|transtorno escolar)/i,
      specialty: 'psicopedagogia',
      not: 'psicologia'
    },
    {
      pattern: /(não fala|atraso na fala|gagueira|problema para engolir|mastigação)/i,
      specialty: 'fonoaudiologia'
    },
    {
      pattern: /(hiperativo|não para quieto|impulsivo|não concentra|tdah)/i,
      specialty: 'neuropsicologia',
      alsoConsider: 'psicologia'
    },
    {
      pattern: /(não anda|coordenação|equilíbrio|postura|fortalecimento)/i,
      specialty: 'fisioterapia'
    },
    {
      pattern: /(não brinca|sensorial|motor fino|independência|autonomia)/i,
      specialty: 'terapia_ocupacional'
    }
  ],

  // Cenários de borda críticos
  EDGE_CASES: {
    saturday_request: {
      pattern: /(sábado|domingo|fim de semana)/i,
      response: 'No momento não atendemos fins de semana. Temos disponibilidade de segunda a sexta, manhã e tarde. Qual dia funciona melhor? 💚',
      offer: ['segunda_manha', 'quarta_tarde', 'sexta_manha']
    },
    
    early_morning: {
      pattern: /(07:00|07h|7 horas|cedo|antes do trabalho)/i,
      response: 'Temos horários especiais às 7h justamente para quem trabalha! 💚 É um horário pensado para não atrapalhar sua rotina.',
      confirm: true
    },

    multiple_therapies: {
      pattern: /(fono e psico|fono e to|preciso de várias|todas as terapias)/i,
      response: 'Que bom que vocês têm autorização para várias áreas! 💚 Podemos organizar tudo aqui. Qual você gostaria de começar primeiro?',
      action: 'prioritize_and_schedule_sequential'
    },

    travel_return: {
      pattern: /(cheguei de viagem|voltei|estava fora|viajei)/i,
      response: 'Que bom que voltou! 💚 Vou verificar a agenda e já te confirmo os horários disponíveis.',
      fastTrack: true
    },

    waiting_confirmation: {
      pattern: /(vou confirmar|falar com minha mãe|consultar|perguntar para)/i,
      response: 'Claro! 💚 Decisão importante assim tem que ser em conjunto. Fico no aguardo do retorno de vocês!',
      scheduleFollowUp: 48 // horas
    }
  },

  // Respostas que indicam problema no sistema
  SYSTEM_FAILURE_INDICATORS: [
    'duplicando mensagem',
    'não entendi',
    'não entendeu',
    'você não sabe',
    'quero falar com gente',
    'quero falar com uma pessoa',
    'sistema com erro',
    'não está funcionando'
  ],

  // Thresholds para decisões
  THRESHOLDS: {
    shortReplyMaxLength: 15,
    confidenceForFallback: 0.4,
    hoursForWarmRecall: 48,
    daysForReactivation: 30,
    maxMessagesInContext: 10
  }
};

/**
 * 🧠 Regras de aprendizado contínuo
 */
export const LEARNING_RULES = {
  // Quando um caso real falhar, registre aqui
  onFallbackUsed: (context, result) => {
    return {
      timestamp: new Date().toISOString(),
      trigger: context.userMessage,
      decision: result.action,
      confidence: result.confidence,
      shouldReview: result.confidence < 0.6
    };
  },

  // Quando sistema padrão falhar e SmartFallback salvar
  onSmartFallbackSuccess: (originalResult, fallbackResult) => {
    return {
      originalFailed: originalResult.text,
      fallbackUsed: fallbackResult.text,
      improvement: fallbackResult.meta.reasoning,
      addToTraining: true
    };
  }
};

export default REAL_WORLD_PATTERNS;
