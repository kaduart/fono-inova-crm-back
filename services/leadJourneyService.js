/**
 * 🛤️ Serviço de Jornada do Lead
 * Rastreamento completo com persistência localStorage + session
 */

import { v4 as uuidv4 } from 'uuid';
import Lead from '../models/Lead.js';

// Configurações
const JOURNEY_COOKIE_NAME = 'fono_journey_id';
const SESSION_COOKIE_NAME = 'fono_session_id';
const COOKIE_EXPIRY_DAYS = 90;

/**
 * 🎯 Inicia ou recupera jornada do lead
 * Chamado quando usuário acessa qualquer página
 */
export async function initLeadJourney(req, res) {
  // 1. Verificar cookies existentes
  let journeyId = req.cookies?.[JOURNEY_COOKIE_NAME];
  let sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  
  // 2. Se não tem journeyId, criar novo
  if (!journeyId) {
    journeyId = generateJourneyId();
    setCookie(res, JOURNEY_COOKIE_NAME, journeyId, COOKIE_EXPIRY_DAYS);
  }
  
  // 3. Sempre criar nova sessão se não existir ou se mudou significativamente
  if (!sessionId || shouldCreateNewSession(req)) {
    sessionId = generateSessionId();
    setCookie(res, SESSION_COOKIE_NAME, sessionId, 0); // session cookie
  }
  
  // 4. Extrair dados da URL (UTM, referrer, etc)
  const journeyData = extractJourneyData(req);
  
  // 5. Salvar ou atualizar no banco
  const journey = await saveJourneyData(journeyId, sessionId, journeyData);
  
  return {
    journeyId,
    sessionId,
    isNew: !req.cookies?.[JOURNEY_COOKIE_NAME],
    journey
  };
}

/**
 * 📊 Registra interação na jornada
 */
export async function trackInteraction(journeyId, interaction) {
  const journey = await Lead.findOne({ journeyId });
  
  if (!journey) {
    console.warn(`Journey não encontrada: ${journeyId}`);
    return null;
  }
  
  const interactionData = {
    type: interaction.type, // 'page_view', 'scroll', 'click', 'form_start', 'whatsapp_click', etc
    page: interaction.page,
    timestamp: new Date(),
    metadata: interaction.metadata || {}
  };
  
  // Adicionar à timeline
  journey.journeyTimeline = journey.journeyTimeline || [];
  journey.journeyTimeline.push(interactionData);
  
  // Atualizar última atividade
  journey.lastActivityAt = new Date();
  
  // Atualizar contadores específicos
  if (interaction.type === 'page_view') {
    journey.pageViews = (journey.pageViews || 0) + 1;
  }
  if (interaction.type === 'whatsapp_click') {
    journey.whatsappClicks = (journey.whatsappClicks || 0) + 1;
  }
  
  await journey.save();
  return interactionData;
}

/**
 * 🔗 Conecta jornada a um lead identificado (quando preenche formulário)
 */
export async function identifyLead(journeyId, leadData) {
  const journey = await Lead.findOne({ journeyId });
  
  if (!journey) {
    // Criar novo lead com journey
    return await Lead.create({
      journeyId,
      ...leadData,
      identifiedAt: new Date(),
      source: journeyData?.source || 'organic'
    });
  }
  
  // Atualizar lead existente
  Object.assign(journey, leadData);
  journey.identifiedAt = new Date();
  journey.isIdentified = true;
  
  await journey.save();
  return journey;
}

/**
 * 📈 Recupera jornada completa do lead
 */
export async function getLeadJourney(journeyId) {
  const journey = await Lead.findOne({ journeyId })
    .select('journeyId sessionId source utmSource utmMedium utmCampaign landingPage journeyTimeline createdAt identifiedAt');
  
  if (!journey) return null;
  
  // Calcular métricas da jornada
  const timeline = journey.journeyTimeline || [];
  
  return {
    journeyId: journey.journeyId,
    sessionId: journey.sessionId,
    source: journey.source,
    utm: {
      source: journey.utmSource,
      medium: journey.utmMedium,
      campaign: journey.utmCampaign
    },
    landingPage: journey.landingPage,
    createdAt: journey.createdAt,
    identifiedAt: journey.identifiedAt,
    isIdentified: !!journey.identifiedAt,
    
    // Métricas calculadas
    metrics: {
      totalInteractions: timeline.length,
      pageViews: timeline.filter(t => t.type === 'page_view').length,
      whatsappClicks: timeline.filter(t => t.type === 'whatsapp_click').length,
      timeOnSite: calculateTimeOnSite(timeline),
      pagesVisited: [...new Set(timeline.filter(t => t.type === 'page_view').map(t => t.page))],
      conversionFunnel: calculateFunnel(timeline)
    },
    
    // Timeline detalhada
    timeline: timeline.slice(-50) // últimas 50 interações
  };
}

/**
 * 🔄 Recupera jornada por múltiplos identificadores
 * Útil quando temos journeyId, phone, email, etc
 */
export async function getJourneyByIdentifier(identifier) {
  // Tentar encontrar por journeyId
  let journey = await Lead.findOne({ journeyId: identifier });
  if (journey) return journey;
  
  // Tentar por telefone
  journey = await Lead.findOne({ 
    $or: [
      { phone: identifier },
      { whatsapp: identifier },
      { email: identifier }
    ]
  });
  
  return journey;
}

// ============ HELPERS ============

function generateJourneyId() {
  return `jny_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
}

function generateSessionId() {
  return `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}_${Date.now()}`;
}

function setCookie(res, name, value, days) {
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  };
  
  if (days > 0) {
    options.maxAge = days * 24 * 60 * 60 * 1000;
  }
  
  res.cookie(name, value, options);
}

function shouldCreateNewSession(req) {
  // Criar nova sessão se:
  // - Última atividade foi há mais de 30 minutos
  // - Mudou de UTM source/medium
  // - Veio de referrer diferente
  
  const lastActivity = req.headers['x-last-activity'];
  if (lastActivity) {
    const minutesSince = (Date.now() - new Date(lastActivity)) / (1000 * 60);
    if (minutesSince > 30) return true;
  }
  
  return false;
}

function extractJourneyData(req) {
  const query = req.query || {};
  const headers = req.headers || {};
  
  return {
    // UTM Parameters
    source: query.utm_source || query.source || 'organic',
    medium: query.utm_medium || query.medium || 'direct',
    campaign: query.utm_campaign || query.campaign,
    content: query.utm_content || query.content,
    term: query.utm_term || query.term,
    
    // Página atual
    landingPage: req.originalUrl || req.url,
    referrer: headers.referer || headers.referrer,
    userAgent: headers['user-agent'],
    
    // Geo (se disponível)
    ip: req.ip,
    country: req.headers['cf-ipcountry'],
    
    // Timestamp
    startedAt: new Date()
  };
}

async function saveJourneyData(journeyId, sessionId, data) {
  // Tentar atualizar existente
  const existing = await Lead.findOne({ journeyId });
  
  if (existing) {
    // Atualizar sessão se mudou
    if (existing.sessionId !== sessionId) {
      existing.sessionId = sessionId;
      existing.sessionCount = (existing.sessionCount || 0) + 1;
    }
    
    existing.lastActivityAt = new Date();
    await existing.save();
    return existing;
  }
  
  // Criar novo registro de jornada (ainda não é um lead completo)
  return await Lead.create({
    journeyId,
    sessionId,
    source: data.source,
    utmSource: data.source,
    utmMedium: data.medium,
    utmCampaign: data.campaign,
    landingPage: data.landingPage,
    referrer: data.referrer,
    userAgent: data.userAgent,
    ip: data.ip,
    sessionCount: 1,
    journeyTimeline: [{
      type: 'journey_started',
      page: data.landingPage,
      timestamp: new Date(),
      metadata: { source: data.source, medium: data.medium }
    }],
    createdAt: new Date(),
    lastActivityAt: new Date()
  });
}

function calculateTimeOnSite(timeline) {
  if (timeline.length < 2) return 0;
  
  const first = new Date(timeline[0].timestamp);
  const last = new Date(timeline[timeline.length - 1].timestamp);
  
  return Math.round((last - first) / 1000); // segundos
}

function calculateFunnel(timeline) {
  const pages = timeline.filter(t => t.type === 'page_view').length;
  const whatsapp = timeline.filter(t => t.type === 'whatsapp_click').length;
  const form = timeline.filter(t => t.type === 'form_start').length;
  
  return {
    awareness: pages > 0,
    interest: pages > 1,
    consideration: form > 0 || whatsapp > 0,
    conversion: whatsapp > 0
  };
}

// ============ MIDDLEWARE ============

/**
 * Middleware Express para tracking automático
 */
export function journeyTrackingMiddleware() {
  return async (req, res, next) => {
    try {
      // Iniciar jornada
      const journey = await initLeadJourney(req, res);
      
      // Anexar à requisição
      req.journey = journey;
      
      // Track page view automaticamente
      if (journey?.journeyId) {
        await trackInteraction(journey.journeyId, {
          type: 'page_view',
          page: req.originalUrl || req.url,
          metadata: {
            referrer: req.headers.referer,
            userAgent: req.headers['user-agent']
          }
        });
      }
      
      next();
    } catch (error) {
      console.error('Erro no journey tracking:', error);
      next(); // Não bloquear requisição
    }
  };
}

export default {
  initLeadJourney,
  trackInteraction,
  identifyLead,
  getLeadJourney,
  getJourneyByIdentifier,
  journeyTrackingMiddleware
};
