// services/intelligence/ConversationAnalysisService.js
// Extrai e analisa conversas reais do MongoDB para aprendizado contínuo

import Message from '../../models/Message.js';
import Lead from '../../models/Leads.js';
// ❌ DEPRECATED: import ChatContext from '../../models/ChatContext.js';
import Appointment from '../../models/Appointment.js';

/**
 * 📊 CONFIGURAÇÃO DE ANÁLISE
 */
const ANALYSIS_CONFIG = {
  // Janela de análise (últimos X dias)
  lookbackDays: 7,
  
  // Mínimo de mensagens para considerar uma conversa válida
  minMessages: 3,
  
  // Máximo de conversas a analisar por rodada
  maxConversations: 100,
  
  // Status considerados como sucesso
  successStatuses: ['virou_paciente', 'agendado', 'converted', 'scheduled'],
  
  // Status considerados como falha/perda
  failureStatuses: ['sem_interesse', 'nao_respondeu', 'desistiu', 'cancelado'],
  
  // Status de engajamento ativo
  engagementStatuses: ['novo', 'primeiro_contato', 'engajado', 'pesquisando_preco']
};

/**
 * 🎯 RESULTADOS DE UMA CONVERSA ANALISADA
 * @typedef {Object} ConversationResult
 * @property {string} leadId
 * @property {string} outcome - 'success' | 'failure' | 'engaged' | 'abandoned'
 * @property {number} messageCount
 * @property {number} durationMinutes
 * @property {string[]} topics - Temas detectados
 * @property {Object[]} keyInteractions - Interações críticas
 * @property {Object} metadata - Dados adicionais
 */

/**
 * 🔍 BUSCA CONVERSAS RECENTES NO MONGODB
 * Busca leads com mensagens nos últimos X dias
 */
export async function fetchRecentConversations(days = ANALYSIS_CONFIG.lookbackDays) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  
  console.log(`🔍 [ANALYSIS] Buscando conversas desde ${since.toISOString()}`);
  
  // Busca leads que tiveram atividade recente
  const leads = await Lead.find({
    $or: [
      { lastInteractionAt: { $gte: since } },
      { updatedAt: { $gte: since } },
      { createdAt: { $gte: since } }
    ]
  })
  .select('_id name status contact origin createdAt updatedAt lastInteractionAt')
  .limit(ANALYSIS_CONFIG.maxConversations)
  .lean();
  
  console.log(`📊 [ANALYSIS] ${leads.length} leads encontrados`);
  
  // Para cada lead, busca suas mensagens e contexto
  const conversations = await Promise.all(
    leads.map(async (lead) => {
      const [messages, chatContext, appointments] = await Promise.all([
        // Mensagens do lead
        Message.find({
          lead: lead._id,
          type: 'text',
          timestamp: { $gte: since }
        })
        .sort({ timestamp: 1 })
        .select('direction content timestamp status')
        .lean(),
        
        // Contexto do chat (memória da Amanda)
        ChatContext.findOne({ lead: lead._id })
          .select('history extractedInfo flags')
          .lean(),
        
        // Agendamentos relacionados
        Appointment.find({
          $or: [
            { lead: lead._id },
            { 'patient.contact.phone': lead.contact?.phone }
          ]
        })
        .select('date status createdAt')
        .sort({ createdAt: -1 })
        .limit(1)
        .lean()
      ]);
      
      return {
        lead,
        messages,
        chatContext,
        appointments,
        analysisDate: new Date()
      };
    })
  );
  
  // Filtra apenas conversas com mensagens suficientes
  return conversations.filter(c => c.messages.length >= ANALYSIS_CONFIG.minMessages);
}

/**
 * 🎯 CLASSIFICA O RESULTADO DE UMA CONVERSA
 */
export function classifyConversationOutcome(conversation) {
  const { lead, messages, appointments } = conversation;
  const status = (lead.status || '').toLowerCase();
  
  // Verifica sucesso
  if (ANALYSIS_CONFIG.successStatuses.includes(status) || appointments.length > 0) {
    return {
      outcome: 'success',
      reason: appointments.length > 0 ? 'appointment_created' : 'lead_converted',
      confidence: 0.9
    };
  }
  
  // Verifica falha explícita
  if (ANALYSIS_CONFIG.failureStatuses.includes(status)) {
    return {
      outcome: 'failure',
      reason: status,
      confidence: 0.8
    };
  }
  
  // Verifica abandono (última mensagem do lead há muito tempo)
  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
  if (lastInbound) {
    const hoursSinceLastMessage = (new Date() - new Date(lastInbound.timestamp)) / (1000 * 60 * 60);
    if (hoursSinceLastMessage > 48) {
      return {
        outcome: 'abandoned',
        reason: 'no_response_48h',
        confidence: 0.7
      };
    }
  }
  
  // Engajamento ativo
  return {
    outcome: 'engaged',
    reason: 'active_conversation',
    confidence: 0.6
  };
}

/**
 * 🔎 DETECTA TÓPICOS DISCUTIDOS NA CONVERSA
 */
export function detectTopics(messages) {
  const allText = messages
    .map(m => (m.content || '').toLowerCase())
    .join(' ');
  
  const topics = [];
  
  // Mapeamento de padrões para tópicos
  const topicPatterns = {
    'preco': /\b(pre[çc]o|valor|quanto|custa|r\$|reais?|consulta.*\d+)\b/,
    'idade': /\b(\d+\s*(anos?|a)|crian[çc]a|beb[eê]|meses?)\b/,
    'multiplos_filhos': /\b(duas?|dois|tr[eê]s|quatro).*(crian[çc]as?|filhos?|filhas?)|gêmeos|m[úu]ltiplos?\b/,
    'convenio': /\b(conv[eê]nio|plano\s+de\s+sa[uú]de|sulamerica|unimed|bradesco|amil|notredame)\b/,
    'cancelamento': /\b(cancelar|desistir|n[aã]o\s+vou|imprevisto|remarcar)\b/,
    'horario': /\b(hor[áa]rio|hor[áa]|manh[aã]|tarde|semana|dispon[ií]vel|vaga)\b/,
    'localizacao': /\b(endere[çc]o|onde\s+fica|local|bairro|como\s+chegar)\b/,
    'terapia': /\b(fonoaudiologia|fonoaudi[oó]loga|terapia|tratamento|sess[aã]o|avalia[çc][aã]o)\b/,
    'indicacao': /\b(indica[çc][aã]o|indicou|recomendou|falaram|amiga|m[eé]dico)\b/,
    'urgencia': /\b(urgente|emerg[eê]ncia|preciso|r[aá]pido|logo|amanh[aã])\b/,
    'duvida': /\b(d[uú]vida|pergunta|queria\s+saber|posso|pode|qual)\b/,
    'silencio': /^(\?+|\.\.\.|ok|hm|hmm)$/i
  };
  
  for (const [topic, pattern] of Object.entries(topicPatterns)) {
    if (pattern.test(allText)) {
      topics.push(topic);
    }
  }
  
  return topics;
}

/**
 * ⚠️ DETECTA PONTOS DE FRICÇÃO/CONFUSÃO
 */
export function detectFrictionPoints(messages) {
  const frictionPoints = [];
  
  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    
    // Se Amanda perguntou algo e lead respondeu algo não relacionado
    if (current.direction === 'outbound' && next.direction === 'inbound') {
      const currentContent = (current.content || '').toLowerCase();
      const nextContent = (next.content || '').toLowerCase();
      
      // Padrões de confusão
      const confusionPatterns = [
        {
          name: 'repete_pergunta',
          pattern: /\b(repete|n[aã]o\s+entendi|como\s+assim|o\s+qu[eê])\b/i,
          severity: 'medium'
        },
        {
          name: 'ignora_pergunta',
          pattern: /\b(deixa|esquece|outra\s+coisa|mudando\s+de\s+assunto)\b/i,
          severity: 'medium'
        },
        {
          name: 'resposta_aleatoria',
          test: (amandaMsg, leadMsg) => {
            // Detecta se lead mudou completamente de assunto
            const amandaKeywords = extractKeywords(amandaMsg);
            const leadKeywords = extractKeywords(leadMsg);
            const overlap = amandaKeywords.filter(k => leadKeywords.includes(k));
            return overlap.length === 0 && amandaKeywords.length > 0;
          },
          severity: 'high'
        }
      ];
      
      for (const fp of confusionPatterns) {
        if (fp.pattern && fp.pattern.test(nextContent)) {
          frictionPoints.push({
            type: fp.name,
            severity: fp.severity,
            amandaMessage: current.content,
            leadResponse: next.content,
            index: i
          });
        } else if (fp.test && fp.test(currentContent, nextContent)) {
          frictionPoints.push({
            type: fp.name,
            severity: fp.severity,
            amandaMessage: current.content,
            leadResponse: next.content,
            index: i
          });
        }
      }
    }
  }
  
  return frictionPoints;
}

/**
 * 📈 EXTRAI MÉTRICAS DA CONVERSA
 */
export function extractConversationMetrics(conversation) {
  const { messages, lead } = conversation;
  
  const inboundMessages = messages.filter(m => m.direction === 'inbound');
  const outboundMessages = messages.filter(m => m.direction === 'outbound');
  
  // Tempo total da conversa
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];
  const durationMinutes = (new Date(lastMessage.timestamp) - new Date(firstMessage.timestamp)) / (1000 * 60);
  
  // Tempo médio de resposta da Amanda
  let amandaResponseTimes = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].direction === 'inbound' && messages[i + 1].direction === 'outbound') {
      const responseTime = new Date(messages[i + 1].timestamp) - new Date(messages[i].timestamp);
      amandaResponseTimes.push(responseTime / 1000); // em segundos
    }
  }
  
  const avgAmandaResponseTime = amandaResponseTimes.length > 0
    ? amandaResponseTimes.reduce((a, b) => a + b, 0) / amandaResponseTimes.length
    : 0;
  
  // Contagem de interações
  const interactionCount = Math.min(inboundMessages.length, outboundMessages.length);
  
  return {
    totalMessages: messages.length,
    inboundCount: inboundMessages.length,
    outboundCount: outboundMessages.length,
    durationMinutes: Math.round(durationMinutes),
    interactionCount,
    avgAmandaResponseTime: Math.round(avgAmandaResponseTime),
    leadMessageLength: Math.round(
      inboundMessages.reduce((sum, m) => sum + (m.content || '').length, 0) / inboundMessages.length || 0
    )
  };
}

/**
 * 🧠 ANÁLISE COMPLETA DE UMA CONVERSA
 */
export function analyzeConversation(conversation) {
  const outcome = classifyConversationOutcome(conversation);
  const topics = detectTopics(conversation.messages);
  const frictionPoints = detectFrictionPoints(conversation.messages);
  const metrics = extractConversationMetrics(conversation);
  
  return {
    leadId: conversation.lead._id.toString(),
    leadStatus: conversation.lead.status,
    leadOrigin: conversation.lead.origin,
    outcome: outcome.outcome,
    outcomeReason: outcome.reason,
    outcomeConfidence: outcome.confidence,
    topics,
    frictionPoints,
    metrics,
    messageCount: conversation.messages.length,
    analysisDate: new Date()
  };
}

/**
 * 📊 ANÁLISE EM LOTE DE CONVERSAS
 */
export async function analyzeConversationsBatch(conversations) {
  const results = {
    total: conversations.length,
    byOutcome: {
      success: [],
      failure: [],
      engaged: [],
      abandoned: []
    },
    topics: {},
    frictionPatterns: {},
    avgMetrics: {
      durationMinutes: 0,
      messageCount: 0,
      interactionCount: 0
    }
  };
  
  let totalDuration = 0;
  let totalMessages = 0;
  let totalInteractions = 0;
  
  for (const conversation of conversations) {
    const analysis = analyzeConversation(conversation);
    
    // Agrupa por resultado
    results.byOutcome[analysis.outcome].push(analysis);
    
    // Conta tópicos
    for (const topic of analysis.topics) {
      results.topics[topic] = (results.topics[topic] || 0) + 1;
    }
    
    // Conta padrões de fricção
    for (const fp of analysis.frictionPoints) {
      results.frictionPatterns[fp.type] = (results.frictionPatterns[fp.type] || 0) + 1;
    }
    
    // Acumula métricas
    totalDuration += analysis.metrics.durationMinutes;
    totalMessages += analysis.metrics.totalMessages;
    totalInteractions += analysis.metrics.interactionCount;
  }
  
  // Calcula médias
  if (results.total > 0) {
    results.avgMetrics = {
      durationMinutes: Math.round(totalDuration / results.total),
      messageCount: Math.round(totalMessages / results.total),
      interactionCount: Math.round(totalInteractions / results.total)
    };
  }
  
  return results;
}

/**
 * 🎯 BUSCA CONVERSAS ESPECÍFICAS PARA TREINAMENTO
 * Útil para encontrar casos de teste
 */
export async function findConversationsForTraining(criteria = {}) {
  const {
    outcome,        // 'success', 'failure', 'engaged', 'abandoned'
    topic,          // 'preco', 'multiplos_filhos', etc
    minMessages,
    limit = 10
  } = criteria;
  
  // Busca conversas recentes
  const conversations = await fetchRecentConversations(30); // Últimos 30 dias
  
  // Analisa e filtra
  const analyzed = conversations.map(analyzeConversation);
  
  return analyzed.filter(a => {
    if (outcome && a.outcome !== outcome) return false;
    if (topic && !a.topics.includes(topic)) return false;
    if (minMessages && a.messageCount < minMessages) return false;
    return true;
  }).slice(0, limit);
}

// ==================== HELPERS ====================

function extractKeywords(text) {
  const stopWords = ['a', 'o', 'as', 'os', 'de', 'da', 'do', 'em', 'no', 'na', 'por', 'para', 'com', 'um', 'uma'];
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));
}

// Exportações
export default {
  fetchRecentConversations,
  analyzeConversation,
  analyzeConversationsBatch,
  findConversationsForTraining,
  classifyConversationOutcome,
  detectTopics,
  detectFrictionPoints,
  extractConversationMetrics
};
