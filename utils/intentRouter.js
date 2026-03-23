/**
 * 🧠 ROTEADOR DE INTENÇÃO — Amanda FSM V8
 * 
 * Detecta a intenção do lead ANTES de responder
 * Resolve o problema da resposta genérica "qual área você precisa?"
 */

// ═══════════════════════════════════════════════════════════
// DETECTORES DE INTENÇÃO
// ═══════════════════════════════════════════════════════════

const INTENT_PATTERNS = {
  scheduling: {
    keywords: [
      'agendar', 'marcar', 'consulta', 'avaliação', 'avaliacao',
      'quero marcar', 'quero agendar', 'tem horário', 'tem horario',
      'disponível', 'disponivel', 'tem vaga', 'quando tem',
      'pode agendar', 'pode marcar', 'gostaria de agendar',
      'como faço pra marcar', 'como faço pra agendar'
    ],
    priority: 'HIGH',
    responseType: 'scheduling_direct'
  },
  
  urgency: {
    keywords: [
      'não fala', 'nao fala', 'não anda', 'nao anda',
      'urgente', 'desesperado', 'desesperada', 'preocupado', 'preocupada',
      'piorando', 'muito mal', 'não aguento', 'nao aguento',
      'atraso', 'atrasada', 'não responde', 'nao responde',
      'desenvolvimento', 'preocupação', 'preocupacao'
    ],
    priority: 'CRITICAL',
    responseType: 'urgency_empathy'
  },
  
  price: {
    keywords: [
      'valor', 'preço', 'preco', 'quanto custa', 'custa',
      'r$', 'reais', 'pacote', 'desconto', 'parcela',
      'valores', 'orçamento', 'orcamento', 'forma de pagamento'
    ],
    priority: 'MEDIUM',
    responseType: 'price_clear'
  },
  
  firstContact: {
    keywords: [
      'oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite',
      'gostaria de', 'quero', 'preciso', 'vocês atendem'
    ],
    priority: 'LOW',
    responseType: 'welcome_qualify'
  }
};

// ═══════════════════════════════════════════════════════════
// VARIAÇÕES DE RESPOSTA (anti-robô)
// ═══════════════════════════════════════════════════════════

const RESPONSE_VARIATIONS = {
  scheduling: {
    opening: [
      'Perfeito, vou te ajudar com o agendamento 💚',
      'Claro! Vamos organizar essa avaliação 💚',
      'Ótimo, vou te ajudar a encontrar o melhor horário 💚',
      'Legal! Vamos ver a disponibilidade 💚'
    ],
    cta: [
      'Você prefere período da manhã ou tarde?',
      'Qual seu horário de preferência: manhã ou tarde?',
      'Manhã ou tarde funciona melhor pra você?',
      'Tem preferência por manhã ou tarde?'
    ],
    afterAreaKnown: [
      'Perfeito! Vou verificar disponibilidade para {therapy}. Prefere manhã ou tarde?',
      'Ótimo! Para {therapy}, tenho alguns horários. Manhã ou tarde é melhor?',
      'Legal! Vou reservar um horário de {therapy}. Qual período: manhã ou tarde?'
    ]
  },
  
  urgency: {
    opening: [
      'Entendo sua preocupação, isso realmente chama atenção 💚',
      'Compreendo o que está sentindo, vou te ajudar com isso 💚',
      'Obrigado por compartilhar isso comigo. Vamos cuidar disso juntos 💚',
      'Sei que isso pode ser preocupante. Estou aqui para ajudar 💚'
    ],
    cta: [
      'Para eu direcionar da melhor forma, qual a idade da criança?',
      'Me conta: qual a idade dele/ela?',
      'Qual a idade para eu verificar a melhor especialidade?',
      'Primeiro: quantos anos ele/ela tem?'
    ]
  },
  
  price: {
    standard: 'A avaliação inicial é **R$ 200** (fonoaudiologia R$ 250). Se me disser a área exata, passo o valor certinho 💚',
    withContext: 'Para {therapy}, o valor é {price}. Quer que eu verifique disponibilidade de horário? 💚'
  },
  
  firstContact: {
    opening: [
      'Oi! Tudo bem? 💚',
      'Olá! Como posso ajudar? 💚',
      'Oi! Bem-vindo à Clínica 💚'
    ],
    qualify: 'Para eu direcionar certinho, qual área você precisa? Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia?'
  }
};

// ═══════════════════════════════════════════════════════════
// FUNÇÕES DE DETECÇÃO
// ═══════════════════════════════════════════════════════════

export function detectIntent(message) {
  if (!message) return { intent: 'unknown', confidence: 0 };
  
  const lowerMsg = message.toLowerCase();
  const scores = {};
  
  // Calcula score para cada intenção
  for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
    scores[intent] = 0;
    for (const keyword of config.keywords) {
      if (lowerMsg.includes(keyword.toLowerCase())) {
        scores[intent] += 1;
        // Bônus se a palavra estiver no início
        if (lowerMsg.startsWith(keyword.toLowerCase())) {
          scores[intent] += 0.5;
        }
      }
    }
  }
  
  // Encontra a intenção com maior score
  let bestIntent = 'firstContact';
  let bestScore = 0;
  
  for (const [intent, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }
  
  // Threshold mínimo para considerar uma intenção válida
  if (bestScore < 0.5) {
    bestIntent = 'firstContact';
  }
  
  return {
    intent: bestIntent,
    confidence: bestScore,
    config: INTENT_PATTERNS[bestIntent]
  };
}

export function hasContextHint(message) {
  const lowerMsg = message.toLowerCase();

  // Regras com word-boundary para evitar falsos positivos (ex: "to" dentro de "atendimento")
  const therapyHints = {
    fonoaudiologia: [
      /\bfono\b/, /\bfala\b/, /\blinguagem\b/, /pronunc/, /\bgaguei/,
      /freio lingual/, /linguinha/, /voz\b/, /degluti/,
      /fala tardia/, /atraso.*fala/, /fala.*atraso/,
      /troca.*letra/, /letra.*troca/, /leitura/, /\bler\b/, /dislexia/
    ],
    psicologia: [
      /\bpsicolog/, /\bcomportamento\b/, /\bemocional\b/, /\bansiedade\b/,
      /\bautismo\b/, /\btea\b/, /\btdah\b/, /\bhiperativ/, /\bagressiv/,
      /\bbirra\b/, /dificuldade.*aten/, /aten.*dificuldade/
    ],
    terapia_ocupacional: [
      /\bterapia ocupacional\b/, /\bterapeuta ocupacional\b/,
      /\bmotricidade\b/, /\bsensorial\b/, /\bpsicomotricidade\b/,
      /coordena[çc][aã]o motora/, /\bmotor[ai]?\b/
    ],
    fisioterapia: [
      /\bfisio/, /fisioterapia/, /\bmarcha\b/, /\bpostura\b/, /prematur/
    ],
    neuropsicologia: [
      /neuropsico/, /\bcognitivo\b/, /mem[oó]ria/, /\baprendizado\b/,
      /avalia[çc][aã]o neuropsicol/
    ]
  };

  for (const [therapy, patterns] of Object.entries(therapyHints)) {
    if (patterns.some(p => p.test(lowerMsg))) {
      return therapy;
    }
  }

  return null;
}

export function hasAgeInfo(message) {
  const ageMatch = message.match(/(\d+)\s*(anos?|años?|years?)/i);
  return ageMatch ? parseInt(ageMatch[1]) : null;
}

// ═══════════════════════════════════════════════════════════
// GERADOR DE RESPOSTA INTELIGENTE
// ═══════════════════════════════════════════════════════════

export function generateSmartResponse(detectedIntent, message, context = {}) {
  const { intent, confidence } = detectedIntent;
  const therapyHint = hasContextHint(message);
  const ageInfo = hasAgeInfo(message);
  
  // Se for scheduling E já tiver contexto de terapia → não perguntar área
  if (intent === 'scheduling' && therapyHint) {
    const variations = RESPONSE_VARIATIONS.scheduling.afterAreaKnown;
    const randomVariation = variations[Math.floor(Math.random() * variations.length)];
    const therapyName = INTENT_PATTERNS.therapy?.name || therapyHint;
    
    return randomVariation.replace('{therapy}', therapyName);
  }
  
  // Se for scheduling mas sem contexto → perguntar período direto (não área!)
  if (intent === 'scheduling' && !therapyHint) {
    const openings = RESPONSE_VARIATIONS.scheduling.opening;
    const ctas = RESPONSE_VARIATIONS.scheduling.cta;
    
    const randomOpening = openings[Math.floor(Math.random() * openings.length)];
    const randomCta = ctas[Math.floor(Math.random() * ctas.length)];
    
    return `${randomOpening}\n\n${randomCta}`;
  }
  
  // Se for urgency → empatia primeiro!
  if (intent === 'urgency') {
    const openings = RESPONSE_VARIATIONS.urgency.opening;
    const ctas = RESPONSE_VARIATIONS.urgency.cta;
    
    const randomOpening = openings[Math.floor(Math.random() * openings.length)];
    const randomCta = ctas[Math.floor(Math.random() * ctas.length)];
    
    // Se já tiver idade na mensagem, adapta
    if (ageInfo) {
      return `${randomOpening}\n\nVou te ajudar a encontrar o melhor profissional. Qual especialidade você busca?`;
    }
    
    return `${randomOpening}\n\n${randomCta}`;
  }
  
  // Se for price → responder preço e puxar próxima ação
  if (intent === 'price') {
    if (therapyHint) {
      // Aqui você pode buscar o preço real da terapia detectada
      return RESPONSE_VARIATIONS.price.withContext
        .replace('{therapy}', therapyHint)
        .replace('{price}', 'R$ 200');
    }
    
    return RESPONSE_VARIATIONS.price.standard;
  }
  
  // Default: firstContact (fluxo normal de qualificação)
  const openings = RESPONSE_VARIATIONS.firstContact.opening;
  const randomOpening = openings[Math.floor(Math.random() * openings.length)];
  
  return `${randomOpening}\n\n${RESPONSE_VARIATIONS.firstContact.qualify}`;
}

// ═══════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL (para usar no AmandaOrchestrator)
// ═══════════════════════════════════════════════════════════

export function routeIntent(message, context = {}) {
  const detected = detectIntent(message);
  const response = generateSmartResponse(detected, message, context);
  
  return {
    intent: detected.intent,
    confidence: detected.confidence,
    response: response,
    hasTherapyHint: hasContextHint(message),
    hasAgeInfo: hasAgeInfo(message)
  };
}

export default {
  detectIntent,
  hasContextHint,
  hasAgeInfo,
  generateSmartResponse,
  routeIntent,
  INTENT_PATTERNS,
  RESPONSE_VARIATIONS
};
