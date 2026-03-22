/**
 * 📱 Serviço de Links WhatsApp com Parâmetros Inteligentes
 * Gera links otimizados com rastreamento de origem
 */

import { URL } from 'url';

// Configurações
const DEFAULT_PHONE = '5562999330311'; // Fono Inova
const DEFAULT_MESSAGE = 'Oi! Vi no site e gostaria de mais informações.';

// Mapeamento de páginas para mensagens contextuais
const PAGE_MESSAGES = {
  // Páginas de fonoaudiologia
  '/fala-tardia': {
    message: 'Oi! Vi no site sobre Fala Tardia e gostaria de saber mais sobre como vocês podem ajudar meu filho.',
    specialty: 'fonoaudiologia',
    context: 'fala_tardia'
  },
  '/fonoaudiologia': {
    message: 'Oi! Vi no site sobre Fonoaudiologia e gostaria de agendar uma avaliação.',
    specialty: 'fonoaudiologia',
    context: 'fonoaudiologia_geral'
  },
  
  // Páginas de autismo
  '/avaliacao-autismo-infantil': {
    message: 'Oi! Vi no site sobre Avaliação de Autismo e gostaria de mais informações sobre o processo.',
    specialty: 'psicologia',
    context: 'avaliacao_autismo'
  },
  '/autismo': {
    message: 'Oi! Vi no site sobre Autismo e gostaria de saber mais sobre os serviços.',
    specialty: 'psicologia',
    context: 'autismo_geral'
  },
  
  // Páginas de dislexia
  '/dislexia-infantil': {
    message: 'Oi! Vi no site sobre Dislexia Infantil e gostaria de ajuda para meu filho.',
    specialty: 'psicopedagogia',
    context: 'dislexia'
  },
  
  // Páginas de TDAH
  '/tdah-infantil': {
    message: 'Oi! Vi no site sobre TDAH Infantil e gostaria de mais informações sobre o tratamento.',
    specialty: 'neuropsicologia',
    context: 'tdah'
  },
  
  // Página geral
  '/': {
    message: 'Oi! Vi no site da Fono Inova e gostaria de mais informações.',
    specialty: null,
    context: 'homepage'
  }
};

/**
 * 🔗 Gera link do WhatsApp com parâmetros inteligentes
 * 
 * @param {Object} options - Opções de geração
 * @param {string} options.page - URL da página de origem
 * @param {string} options.journeyId - ID da jornada do lead
 * @param {string} options.source - Fonte do tráfego (utm_source)
 * @param {string} options.campaign - Campanha (utm_campaign)
 * @param {string} options.customMessage - Mensagem personalizada
 * @param {string} options.specialty - Especialidade pré-selecionada
 * @returns {Object} Link e metadados
 */
export function generateWhatsAppLink(options = {}) {
  const {
    page = '/',
    journeyId = null,
    source = null,
    campaign = null,
    customMessage = null,
    specialty = null
  } = options;
  
  // Detectar contexto da página
  const pageContext = detectPageContext(page);
  
  // Construir mensagem
  const message = buildMessage({
    customMessage,
    pageContext,
    source,
    specialty: specialty || pageContext?.specialty
  });
  
  // Construir URL
  const url = buildWhatsAppUrl({
    phone: DEFAULT_PHONE,
    message,
    journeyId,
    source: source || pageContext?.source,
    campaign,
    page,
    context: pageContext?.context
  });
  
  return {
    url,
    phone: DEFAULT_PHONE,
    message,
    metadata: {
      page,
      source: source || pageContext?.source,
      specialty: specialty || pageContext?.specialty,
      context: pageContext?.context,
      journeyId,
      campaign
    }
  };
}

/**
 * 🔗 Gera link curto (para QR codes, impressos, etc)
 */
export function generateShortLink(destination, options = {}) {
  // Em produção, integrar com serviço de encurtamento (bit.ly, etc)
  const { 
    utm_source = 'qr_code',
    utm_medium = 'print',
    utm_campaign = null 
  } = options;
  
  const params = new URLSearchParams();
  params.set('to', destination);
  if (utm_source) params.set('utm_source', utm_source);
  if (utm_medium) params.set('utm_medium', utm_medium);
  if (utm_campaign) params.set('utm_campaign', utm_campaign);
  
  return {
    url: `https://wa.me/${DEFAULT_PHONE}?${params.toString()}`,
    qrData: `https://wa.me/${DEFAULT_PHONE}?text=${encodeURIComponent(destination)}`
  };
}

/**
 * 📊 Analisa parâmetros recebidos no WhatsApp
 * Extrai UTM, jornada, contexto da mensagem recebida
 */
export function parseIncomingMessage(message, senderPhone) {
  const result = {
    originalMessage: message,
    senderPhone,
    detectedContext: null,
    detectedSpecialty: null,
    detectedPage: null,
    detectedCampaign: null,
    extractedData: {}
  };
  
  // Detectar mensagens padrão do nosso sistema
  const patterns = [
    {
      regex: /Vi no site sobre (.+?) e gostaria/gi,
      extract: (match) => ({ page: match[1], source: 'website' })
    },
    {
      regex: /vim da p[áa]gina de (.+?)(?:\.|,|$)/gi,
      extract: (match) => ({ page: match[1], source: 'lp_specific' })
    },
    {
      regex: /campanha[\s:]+(.+?)(?:\.|,|$)/gi,
      extract: (match) => ({ campaign: match[1] })
    }
  ];
  
  for (const pattern of patterns) {
    const match = pattern.regex.exec(message);
    if (match) {
      Object.assign(result.extractedData, pattern.extract(match));
    }
  }
  
  // Detectar especialidade pela mensagem
  result.detectedSpecialty = detectSpecialtyFromMessage(message);
  result.detectedContext = detectContextFromMessage(message);
  
  return result;
}

/**
 * 🎯 Gera mensagem de boas-vindas personalizada baseada na origem
 */
export function generateWelcomeMessage(parseResult, leadName = null) {
  const { detectedSpecialty, extractedData } = parseResult;
  
  let greeting = leadName ? `Oi ${leadName}!` : 'Oi! Tudo bem?';
  
  // Contextualizar pela especialidade detectada
  if (detectedSpecialty) {
    const specialtyMessages = {
      'fonoaudiologia': `${greeting} Vi que você veio pela página de Fonoaudiologia. Vou te ajudar com informações sobre nossos serviços!`,
      'psicologia': `${greeting} Vi que você tem interesse em Avaliação de Autismo. Posso tirar suas dúvidas sobre o processo!`,
      'psicopedagogia': `${greeting} Vi que você veio pela página sobre Dislexia. Vamos encontrar a melhor forma de ajudar!`,
      'neuropsicologia': `${greeting} Vi que você tem interesse em TDAH. Posso explicar como funciona nosso acompanhamento!`
    };
    
    return specialtyMessages[detectedSpecialty] || `${greeting} Bem-vindo à Fono Inova! Como posso ajudar?`;
  }
  
  // Contextualizar pela página
  if (extractedData.page) {
    return `${greeting} Vi que você veio pela página "${extractedData.page}". Posso te ajudar com mais informações?`;
  }
  
  return `${greeting} Bem-vindo à Fono Inova! Como posso ajudar você hoje?`;
}

// ============ HELPERS ============

function detectPageContext(pageUrl) {
  // Extrair pathname da URL
  let pathname = pageUrl;
  try {
    const url = new URL(pageUrl);
    pathname = url.pathname;
  } catch {
    // pageUrl já é pathname
  }
  
  // Remover trailing slash
  pathname = pathname.replace(/\/$/, '') || '/';
  
  // Buscar match exato
  if (PAGE_MESSAGES[pathname]) {
    return PAGE_MESSAGES[pathname];
  }
  
  // Buscar match parcial
  for (const [key, value] of Object.entries(PAGE_MESSAGES)) {
    if (pathname.includes(key.replace('/', ''))) {
      return value;
    }
  }
  
  // Default
  return {
    message: DEFAULT_MESSAGE,
    specialty: null,
    context: 'generic'
  };
}

function buildMessage({ customMessage, pageContext, source, specialty }) {
  if (customMessage) return customMessage;
  if (pageContext?.message) return pageContext.message;
  return DEFAULT_MESSAGE;
}

function buildWhatsAppUrl({ phone, message, journeyId, source, campaign, page, context }) {
  const params = new URLSearchParams();
  
  // Mensagem principal
  params.set('text', message);
  
  // Parâmetros de rastreamento (adicionados à mensagem para persistência)
  let fullMessage = message;
  
  if (source && !message.includes('utm_source')) {
    fullMessage += `\n\n[Ref: ${source}${campaign ? `/${campaign}` : ''}]`;
  }
  
  if (journeyId) {
    fullMessage += `\n[ID: ${journeyId.substring(0, 8)}]`;
  }
  
  params.set('text', fullMessage);
  
  return `https://wa.me/${phone}?${params.toString()}`;
}

function detectSpecialtyFromMessage(message) {
  const lower = message.toLowerCase();
  
  if (lower.includes('fala') || lower.includes('falar') || lower.includes('fonoaudiologia')) {
    return 'fonoaudiologia';
  }
  if (lower.includes('autismo') || lower.includes('tea') || lower.includes('espectro')) {
    return 'psicologia';
  }
  if (lower.includes('dislexia') || lower.includes('ler') || lower.includes('leitura')) {
    return 'psicopedagogia';
  }
  if (lower.includes('tdah') || lower.includes('hiperatividade') || lower.includes('atenção')) {
    return 'neuropsicologia';
  }
  if (lower.includes('terapia') || lower.includes('ocupacional') || lower.includes('sensorial')) {
    return 'terapia_ocupacional';
  }
  
  return null;
}

function detectContextFromMessage(message) {
  const lower = message.toLowerCase();
  
  if (lower.includes('avaliação')) return 'avaliacao';
  if (lower.includes('tratamento') || lower.includes('terapia')) return 'tratamento';
  if (lower.includes('agendar') || lower.includes('marcar')) return 'agendamento';
  if (lower.includes('preço') || lower.includes('valor') || lower.includes('custo')) return 'preco';
  
  return 'informacao';
}

// ============ API ENDPOINTS ============

/**
 * Controller para rotas Express
 */
export function whatsappLinkController() {
  return {
    // GET /api/whatsapp/link
    getLink: async (req, res) => {
      try {
        const link = generateWhatsAppLink({
          page: req.query.page,
          source: req.query.utm_source,
          campaign: req.query.utm_campaign,
          journeyId: req.query.journey_id,
          customMessage: req.query.message,
          specialty: req.query.specialty
        });
        
        res.json({
          success: true,
          data: link
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    },
    
    // POST /api/whatsapp/parse
    parseMessage: async (req, res) => {
      try {
        const { message, phone } = req.body;
        
        const result = parseIncomingMessage(message, phone);
        const welcomeMessage = generateWelcomeMessage(result);
        
        res.json({
          success: true,
          data: {
            ...result,
            welcomeMessage
          }
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    }
  };
}

export default {
  generateWhatsAppLink,
  generateShortLink,
  parseIncomingMessage,
  generateWelcomeMessage,
  whatsappLinkController
};
