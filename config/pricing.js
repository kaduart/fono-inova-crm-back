/**
 * 💰 CONFIGURAÇÃO CENTRALIZADA DE PREÇOS
 * 
 * REGRA: Todos os preços devem vir daqui.
 * Não hardcode preços em handlers, prompts ou orquestradores.
 * 
 * Última atualização: Fev 2026
 */

// ============================================================
// 📋 PREÇOS BASE (avaliação e sessões)
// ============================================================

export const PRICING = {
  // Avaliação inicial (todas as áreas exceto neuropsico)
  AVALIACAO_INICIAL: 200,
  
  // Sessão avulsa (sem pacote)
  SESSAO_AVULSA: 200,
  
  // Retorno/avaliação neuropsicológica
  RETORNO_NEUROPSICO: 280,
};

// ============================================================
// 🏥 PREÇOS POR ESPECIALIDADE (pacotes mensais)
// ============================================================

export const THERAPY_PRICING = {
  fonoaudiologia: {
    avaliacao: 200,
    sessaoAvulsa: 200,
    pacoteMensal: 720, // 4 sessões
    sessaoPacote: 180,
    descricao: 'Fonoaudiologia',
  },
  psicologia: {
    avaliacao: 200,
    sessaoAvulsa: 200,
    pacoteMensal: 640, // 4 sessões
    sessaoPacote: 160,
    descricao: 'Psicologia',
  },
  terapia_ocupacional: {
    avaliacao: 200,
    sessaoAvulsa: 200,
    pacoteMensal: 640,
    sessaoPacote: 160,
    descricao: 'Terapia Ocupacional',
  },
  fisioterapia: {
    avaliacao: 200,
    sessaoAvulsa: 200,
    pacoteMensal: 640,
    sessaoPacote: 160,
    descricao: 'Fisioterapia',
  },
  musicoterapia: {
    avaliacao: 200,
    sessaoAvulsa: 200,
    pacoteMensal: 640,
    sessaoPacote: 160,
    descricao: 'Musicoterapia',
  },
  psicopedagogia: {
    avaliacao: 200,
    sessaoAvulsa: 200,
    pacoteMensal: 520, // 4 sessões - mais barato
    sessaoPacote: 130,
    descricao: 'Psicopedagogia',
  },
  neuropsicologia: {
    avaliacao: 2000, // Pacote completo ~10 sessões
    sessaoAvulsa: null, // Não vende avulso
    pacoteMensal: null,
    sessaoPacote: 200, // implícito no pacote
    descricao: 'Neuropsicologia',
    parcelamento: 'até 6x',
    incluiLaudo: true,
    sessoesPacote: 10,
  },
};

// Aliases para normalização
export const THERAPY_ALIASES = {
  fono: 'fonoaudiologia',
  fonoaudiologia: 'fonoaudiologia',
  psico: 'psicologia',
  psicologia: 'psicologia',
  to: 'terapia_ocupacional',
  terapia_ocupacional: 'terapia_ocupacional',
  fisio: 'fisioterapia',
  fisioterapia: 'fisioterapia',
  musico: 'musicoterapia',
  musicoterapia: 'musicoterapia',
  psicopedagogia: 'psicopedagogia',
  neuropsico: 'neuropsicologia',
  neuropsicologia: 'neuropsicologia',
};

// ============================================================
// 🎯 HELPERS DE FORMATAÇÃO
// ============================================================

/**
 * Formata valor em reais
 * @param {number} value - Valor numérico
 * @returns {string} - "R$ 200" ou "R$ 2.000"
 */
export function formatPrice(value) {
  if (value === null || value === undefined) return '';
  return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formata valor em reais com centavos
 * @param {number} value - Valor numérico
 * @returns {string} - "R$ 200,00"
 */
export function formatPriceFull(value) {
  if (value === null || value === undefined) return '';
  return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Busca preços de uma terapia (com alias)
 * @param {string} therapyKey - Nome da terapia
 * @returns {Object|null} - Dados de preço ou null
 */
export function getTherapyPricing(therapyKey) {
  if (!therapyKey) return null;
  
  const normalized = THERAPY_ALIASES[therapyKey.toLowerCase().trim()];
  if (!normalized) return null;
  
  return THERAPY_PRICING[normalized] || null;
}

/**
 * Retorna string formatada de preço para uma terapia
 * @param {string} therapyKey - Nome da terapia
 * @returns {string} - Texto formatado com preços
 */
export function getPriceText(therapyKey) {
  const pricing = getTherapyPricing(therapyKey);
  
  if (!pricing) {
    return `A avaliação inicial é ${formatPrice(PRICING.AVALIACAO_INICIAL)} 💚`;
  }
  
  // Neuropsicologia é especial
  if (pricing.incluiLaudo) {
    return `A avaliação neuropsicológica completa (${pricing.sessoesPacote} sessões + laudo) é ${formatPrice(pricing.avaliacao)}${pricing.parcelamento ? ` em ${pricing.parcelamento}` : ''} 💚`;
  }
  
  return `Avaliação: ${formatPrice(pricing.avaliacao)} · Sessão avulsa: ${formatPrice(pricing.sessaoAvulsa)} · Pacote mensal: ${formatPrice(pricing.pacoteMensal)} (${pricing.sessaoPacote}/sessão) 💚`;
}

/**
 * Retorna string de "investimento" (terminologia suave)
 * @param {string} therapyKey - Nome da terapia
 * @returns {string} - Texto de investimento
 */
export function getInvestmentText(therapyKey) {
  const pricing = getTherapyPricing(therapyKey);
  
  if (!pricing) {
    return `O investimento na avaliação é ${formatPrice(PRICING.AVALIACAO_INICIAL)}.`;
  }
  
  if (pricing.incluiLaudo) {
    return `O investimento na avaliação neuropsicológica completa é ${formatPrice(pricing.avaliacao)}${pricing.parcelamento ? ` em ${pricing.parcelamento}` : ''}.`;
  }
  
  return `O investimento na avaliação é ${formatPrice(pricing.avaliacao)}.`;
}

/**
 * Retorna texto de pacote mensal
 * @param {string} therapyKey - Nome da terapia
 * @returns {string} - Texto do pacote
 */
export function getPackageText(therapyKey) {
  const pricing = getTherapyPricing(therapyKey);
  
  if (!pricing || pricing.incluiLaudo) {
    return '';
  }
  
  return `O pacote mensal sai por ${formatPrice(pricing.sessaoPacote)}/sessão (${formatPrice(pricing.pacoteMensal)}/mês com 1x/semana) 💚`;
}

/**
 * Compara avulso vs pacote para objeção de preço
 * @param {string} therapyKey - Nome da terapia
 * @returns {string|null} - Texto comparativo ou null
 */
export function getPriceComparison(therapyKey) {
  const pricing = getTherapyPricing(therapyKey);
  
  if (!pricing || pricing.incluiLaudo) return null;
  
  const economia = (pricing.sessaoAvulsa - pricing.sessaoPacote) * 4;
  
  return `Temos o pacote mensal que sai mais em conta: ${formatPrice(pricing.sessaoPacote)}/sessão vs ${formatPrice(pricing.sessaoAvulsa)} avulsa. Você economiza ${formatPrice(economia)}/mês! 💚`;
}

// ============================================================
// 🎨 TEMPLATES DE RESPOSTA
// ============================================================

/**
 * Template completo: VALOR → URGÊNCIA → PREÇO → RETOMA
 * @param {string} therapyKey - Nome da terapia
 * @param {Object} options - Opções
 * @returns {string} - Resposta completa
 */
export function buildValueFirstResponse(therapyKey, options = {}) {
  const { childAge = null, childName = null, includeUrgency = false } = options;
  
  const pricing = getTherapyPricing(therapyKey);
  const area = pricing?.descricao || 'atendimento';
  
  let response = '';
  
  // 1. VALOR DO TRABALHO (por área)
  const valueTexts = {
    fonoaudiologia: `Na fonoaudiologia, trabalhamos o desenvolvimento da comunicação de forma lúdica e natural. Cada sessão é planejada especificamente para as necessidades da criança.`,
    psicologia: `Na psicologia, criamos um espaço seguro onde a criança pode explorar emoções e comportamentos. O trabalho é totalmente individualizado.`,
    terapia_ocupacional: `Na terapia ocupacional, focamos nas habilidades do dia a dia - desde a coordenação motora até a autonomia. É um trabalho prático e divertido.`,
    fisioterapia: `Na fisioterapia infantil, trabalhamos o desenvolvimento motor com exercícios que parecem brincadeira. Cada sessão é adaptada à idade.`,
    psicopedagogia: `Na psicopedagogia, identificamos como a criança aprende melhor e trabalhamos estratégias para superar as dificuldades escolares.`,
    neuropsicologia: `A avaliação neuropsicológica é um processo completo que mapeia todas as funções cognitivas. O laudo serve para escola, médicos e planejamento terapêutico.`,
  };
  
  const normalized = THERAPY_ALIASES[therapyKey?.toLowerCase().trim()] || therapyKey;
  response += valueTexts[normalized] || `Nosso trabalho de ${area} é totalmente individualizado e focado nos objetivos da família.`;
  
  // 2. URGÊNCIA (se aplicável e solicitado)
  if (includeUrgency && childAge !== null && childAge <= 6) {
    response += ` Com ${childAge} anos, estamos em uma fase importante do desenvolvimento onde o cérebro está muito receptivo a estímulos.`;
  }
  
  // 3. PREÇO
  if (pricing?.incluiLaudo) {
    response += `\n\nO investimento é de ${formatPrice(pricing.avaliacao)}${pricing.parcelamento ? ` em ${pricing.parcelamento}` : ''} (inclui ${pricing.sessoesPacote} sessões + laudo completo).`;
  } else {
    response += `\n\nO investimento na avaliação é ${formatPrice(PRICING.AVALIACAO_INICIAL)}.`;
    if (pricing) {
      response += ` Para acompanhamento, temos sessão avulsa (${formatPrice(pricing.sessaoAvulsa)}) ou pacote mensal que sai ${formatPrice(pricing.sessaoPacote)}/sessão.`;
    }
  }
  
  // 4. RETOMA
  response += `\n\nQuer que eu verifique a disponibilidade de horários? 💚`;
  
  return response;
}

// ============================================================
// 🧪 PARA TESTES
// ============================================================

export function validatePricing() {
  const errors = [];
  
  // Verifica se todas as terapias têm preços
  const requiredTherapies = Object.keys(THERAPY_ALIASES);
  const uniqueTherapies = [...new Set(Object.values(THERAPY_ALIASES))];
  
  for (const therapy of uniqueTherapies) {
    if (!THERAPY_PRICING[therapy]) {
      errors.push(`Falta pricing para: ${therapy}`);
    }
  }
  
  // Verifica consistência de preços
  for (const [key, pricing] of Object.entries(THERAPY_PRICING)) {
    if (pricing.avaliacao <= 0) {
      errors.push(`${key}: avaliação deve ser > 0`);
    }
    if (!pricing.incluiLaudo && pricing.sessaoAvulsa <= 0) {
      errors.push(`${key}: sessaoAvulsa deve ser > 0`);
    }
  }
  
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ============================================================
// 📦 EXPORTAÇÃO PADRÃO (compatibilidade)
// ============================================================

// Compatibilidade com código antigo
export const PRICES = {
  // Compatibilidade com novo sistema
  AVULSO: {
    FONOAUDIOLOGIA: PRICING.SESSAO_AVULSA,
    NEUROPSICOLOGIA: THERAPY_PRICING.neuropsicologia.avaliacao
  },
  PACOTE_2X: {
    FONOAUDIOLOGIA: PRICING.SESSAO_AVULSA * 0.95, // 5% desconto
    NEUROPSICOLOGIA: THERAPY_PRICING.neuropsicologia.avaliacao * 0.95
  },
  PACOTE_4X: {
    FONOAUDIOLOGIA: PRICING.SESSAO_AVULSA * 0.90, // 10% desconto
    NEUROPSICOLOGIA: THERAPY_PRICING.neuropsicologia.avaliacao * 0.90
  },
  // Legado (mantém compatibilidade)
  avaliacaoInicial: formatPriceFull(PRICING.AVALIACAO_INICIAL),
  sessaoAvulsa: formatPriceFull(PRICING.SESSAO_AVULSA),
  pacoteMensal: 'R$ 160,00/sessão (~R$ 640/mês)',
  neuropsicologica: formatPriceFull(THERAPY_PRICING.neuropsicologia.avaliacao) + ' (10 sessões)',
  retornoNeuropsico: formatPriceFull(PRICING.RETORNO_NEUROPSICO),
};

export default {
  PRICING,
  THERAPY_PRICING,
  THERAPY_ALIASES,
  formatPrice,
  formatPriceFull,
  getTherapyPricing,
  getPriceText,
  getInvestmentText,
  getPackageText,
  getPriceComparison,
  buildValueFirstResponse,
  validatePricing,
  PRICES,
};
