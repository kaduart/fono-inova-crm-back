/**
 * 🔍 Campaign Detector
 * Detecta especialidade e origem a partir de mensagens do WhatsApp
 * Resolve o problema do fbclid se perder no deep link do WhatsApp
 */

// Mapeamento de palavras-chave por especialidade
const SPECIALTY_KEYWORDS = {
  psicologia: [
    'psico', 'psicologia', 'psicóloga', 'psicologa', 'terapia', 
    'ansiedade', 'depressão', 'depressao', 'tdah', 'tea', 'autismo',
    'comportamento', 'emocional', 'mental'
  ],
  fono: [
    'fono', 'fonoaudiologia', 'fonoaudiologia', 'fonoaudióloga', 'fonoaudiologa',
    'linguagem', 'fala', 'enrolar', 'língua', 'lingua', 'freio', 'lateral',
    'disfonia', 'gagueira', 'dicção', 'diccao', 'pronuncia', 'mastigação'
  ],
  fisio: [
    'fisio', 'fisioterapia', 'fisioterapeuta', 'fisio', 'coluna', 'postura',
    'coluna', 'ombro', 'joelho', 'costas', 'torticolis', 'torticollic',
    'respiratório', 'respiratorio', 'pilates', 'reabilitação', 'reabilitacao'
  ],
  neuropsicologia: [
    'neuro', 'neuropsicologia', 'neuropsicóloga', 'avaliação neuro', 'avaliacao neuro',
    'funções executivas', 'memória', 'memoria', 'atenção', 'atencao',
    'cognitivo', 'superdotação', 'tdah avaliação'
  ],
  psicopedagogia: [
    'psicopedagogo', 'psicopedagogia', 'aprendizagem', 'escola', 'dificuldade escolar',
    'dislexia', 'discalculia', 'escrita', 'leitura'
  ]
};

// Padrões de nomes de campanha do Meta
const CAMPAIGN_PATTERNS = [
  { regex: /\[?psico\]?/i, specialty: 'psicologia' },
  { regex: /\[?fono\]?/i, specialty: 'fono' },
  { regex: /\[?fisio\]?/i, specialty: 'fisio' },
  { regex: /\[?neuro\]?/i, specialty: 'neuropsicologia' },
  { regex: /\[?psicopeda?\]?/i, specialty: 'psicopedagogia' }
];

/**
 * Detecta especialidade a partir da mensagem do usuário
 * @param {string} message - Texto da mensagem inicial do WhatsApp
 * @returns {string} - Especialidade detectada ou 'geral'
 */
export function detectSpecialtyFromMessage(message) {
  if (!message || typeof message !== 'string') {
    return 'geral';
  }

  const msg = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  
  // Pontuação por especialidade
  const scores = {};
  
  for (const [specialty, keywords] of Object.entries(SPECIALTY_KEYWORDS)) {
    scores[specialty] = 0;
    
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(msg)) {
        scores[specialty] += 1;
      }
    }
  }
  
  // Encontra a especialidade com maior pontuação
  let bestMatch = 'geral';
  let maxScore = 0;
  
  for (const [specialty, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestMatch = specialty;
    }
  }
  
  // Só retorna se tiver pelo menos uma palavra-chave
  return maxScore > 0 ? bestMatch : 'geral';
}

/**
 * Detecta especialidade a partir do nome da campanha do Meta
 * @param {string} campaignName - Nome da campanha (ex: "[conjunto 01][PSICO vendas whatsapp]")
 * @returns {string} - Especialidade detectada ou 'geral'
 */
export function detectSpecialtyFromCampaignName(campaignName) {
  if (!campaignName || typeof campaignName !== 'string') {
    return 'geral';
  }
  
  const name = campaignName.toLowerCase();
  
  for (const pattern of CAMPAIGN_PATTERNS) {
    if (pattern.regex.test(name)) {
      return pattern.specialty;
    }
  }
  
  return 'geral';
}

/**
 * Extrai informações de campanha da mensagem
 * Busca padrões como "vim do anúncio de [especialidade]"
 * @param {string} message - Texto da mensagem
 * @returns {object} - { source, campaign, specialty }
 */
export function extractCampaignFromMessage(message) {
  if (!message || typeof message !== 'string') {
    return { source: null, campaign: null, specialty: null };
  }
  
  const msg = message.toLowerCase();
  let result = {
    source: null,
    campaign: null,
    specialty: null
  };
  
  // Detecta se veio de anúncio
  const adPatterns = [
    /vim (do|pelo) anuncio/i,
    /vim (do|pelo) anúncio/i,
    /vi (no|pelo) anuncio/i,
    /vi (no|pelo) anúncio/i,
    /cliquei (no|pelo) anuncio/i,
    /instagram/i,
    /facebook/i,
    /meta/i,
    /google/i
  ];
  
  for (const pattern of adPatterns) {
    if (pattern.test(msg)) {
      result.source = 'meta_ads';
      break;
    }
  }
  
  // Tenta extrair especialidade
  result.specialty = detectSpecialtyFromMessage(message);
  
  // Se detectou que veio de anúncio e tem especialidade, monta o campaign
  if (result.source && result.specialty !== 'geral') {
    result.campaign = `[whatsapp]-[${result.specialty}]-[${new Date().toISOString().split('T')[0]}]`;
  }
  
  return result;
}

/**
 * Parser completo para quando um lead entra pelo WhatsApp
 * Combina fbclid (se disponível) com análise da mensagem
 * @param {object} params - { message, fbclid, utmCampaign, utmSource }
 * @returns {object} - Dados de tracking completos
 */
export function parseLeadSource({ message, fbclid, utmCampaign, utmSource, utmMedium }) {
  const result = {
    source: '',
    campaign: null,
    specialty: 'geral',
    fbclid: fbclid || null,
    utmSource: utmSource || null,
    utmCampaign: utmCampaign || null,
    utmMedium: utmMedium || null,
    firstMessage: message || null
  };
  
  // Prioridade 1: UTM parameters (mais confiável)
  if (utmSource) {
    result.source = utmSource.toLowerCase();
    if (utmCampaign) {
      result.campaign = utmCampaign;
      result.specialty = detectSpecialtyFromCampaignName(utmCampaign);
    }
    return result;
  }
  
  // Prioridade 2: fbclid (veio do Meta)
  if (fbclid) {
    result.source = 'meta_ads';
  }
  
  // Prioridade 3: Análise da mensagem
  if (message) {
    const extracted = extractCampaignFromMessage(message);
    
    if (extracted.source) {
      result.source = extracted.source;
    }
    if (extracted.campaign) {
      result.campaign = extracted.campaign;
    }
    if (extracted.specialty && extracted.specialty !== 'geral') {
      result.specialty = extracted.specialty;
    } else {
      // Tenta detectar apenas especialidade
      result.specialty = detectSpecialtyFromMessage(message);
    }
  }
  
  return result;
}

/**
 * Calcula CPL (Custo Por Lead) para uma campanha
 * @param {number} spend - Gasto total
 * @param {number} leadsCount - Quantidade de leads
 * @returns {number|null} - CPL ou null
 */
export function calculateCPL(spend, leadsCount) {
  if (spend && leadsCount && leadsCount > 0) {
    return spend / leadsCount;
  }
  return null;
}

/**
 * Calcula CPA (Custo Por Aquisição)
 * @param {number} spend - Gasto total  
 * @param {number} patientsCount - Quantidade de pacientes
 * @returns {number|null} - CPA ou null
 */
export function calculateCPA(spend, patientsCount) {
  if (spend && patientsCount && patientsCount > 0) {
    return spend / patientsCount;
  }
  return null;
}

/**
 * Classifica o CPL como bom, médio ou ruim baseado em benchmarks
 * @param {number} cpl - Custo por lead
 * @param {string} specialty - Especialidade
 * @returns {string} - 'good', 'warning', 'bad'
 */
export function classifyCPL(cpl, specialty) {
  if (!cpl) return 'neutral';
  
  // Benchmarks ajustados para clínica infantil
  const benchmarks = {
    psicologia: { good: 25, warning: 40 },
    fono: { good: 15, warning: 25 },
    fisio: { good: 20, warning: 35 },
    neuropsicologia: { good: 30, warning: 50 },
    default: { good: 20, warning: 35 }
  };
  
  const benchmark = benchmarks[specialty] || benchmarks.default;
  
  if (cpl <= benchmark.good) return 'good';
  if (cpl <= benchmark.warning) return 'warning';
  return 'bad';
}

export default {
  detectSpecialtyFromMessage,
  detectSpecialtyFromCampaignName,
  extractCampaignFromMessage,
  parseLeadSource,
  calculateCPL,
  calculateCPA,
  classifyCPL
};
