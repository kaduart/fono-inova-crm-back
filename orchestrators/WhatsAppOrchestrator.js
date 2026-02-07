import Logger from '../services/utils/Logger.js';
import ChatContext from '../models/ChatContext.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import { updateExtractedInfo } from '../services/leadContext.js';

// 🎯 V5: THERAPY_MAP para fallback
const THERAPY_MAP = {
  // Psicologia
  'ansiedade': 'psicologia', 'depressão': 'psicologia', 'tdah': 'psicologia',
  'psicologia': 'psicologia', 'psicólogo': 'psicologia', 'psicologa': 'psicologia',
  'emocional': 'psicologia', 'comportamento': 'psicologia',
  // Fonoaudiologia
  'autismo': 'fonoaudiologia', 'tea': 'fonoaudiologia', 'fala': 'fonoaudiologia',
  'gagueira': 'fonoaudiologia', 'não fala': 'fonoaudiologia', 
  'atraso de fala': 'fonoaudiologia', 'dificuldade de fala': 'fonoaudiologia',
  'fonoaudiologia': 'fonoaudiologia', 'fono': 'fonoaudiologia',
  'linguagem': 'fonoaudiologia', 'pronúncia': 'fonoaudiologia',
  // Fisioterapia
  'desvio': 'fisioterapia', 'coluna': 'fisioterapia', 'postura': 'fisioterapia',
  'dor': 'fisioterapia', 'lesão': 'fisioterapia', 'reabilitação': 'fisioterapia',
  'fisioterapia': 'fisioterapia', 'fisio': 'fisioterapia',
  'osteopatia': 'fisioterapia', 'avc': 'fisioterapia'
};

// 🧠 Palavras que indicam carga emocional/dor (independentemente da especialidade)
const EMOTIONAL_MARKERS = [
  'desespero', 'desesperada', 'desesperado', 'não aguento', 'não suporto',
  'me mata', 'me consome', 'me destrói', 'me destruido', 'me destruida',
  'sofrimento', 'sofro', 'sofrer', 'angustia', 'angustiada', 'angustiado',
  'medo', 'tenho medo', 'com medo', 'desespero',
  'choro', 'choro todo dia', 'não paro de chorar',
  'depressão', 'deprimida', 'deprimido', 'triste',
  'ansiedade', 'ansiosa', 'ansioso', 'pânico', 'ataque de pânico',
  'estresse', 'estressada', 'estressado',
  'não sei o que fazer', 'perdida', 'perdido', 'sem saída',
  'acabo comigo', 'não quero mais', 'desisti'
];

const VALID_THERAPIES = ['fonoaudiologia', 'psicologia', 'fisioterapia'];

export class WhatsAppOrchestrator {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestrator');
  }

  async process({ lead, message, services }) {
    const text = message?.content || message?.text || '';
    
    // 1. Carrega state
    let state = await this.loadState(lead._id);
    
    // 2. Classifica mensagem (LLM + fallback)
    const extracted = await this.classify(text, state);
    
    // 3. 🛡️ PROTEÇÃO DE CONTEXTO EMOCIONAL (para qualquer especialidade)
    // Detecta se há carga emocional na queixa atual
    const hasEmotionalContent = this.detectEmotionalContent(text);
    
    if (extracted.therapy && state.data.therapy && extracted.therapy !== state.data.therapy) {
      // Mudou de terapia - verifica se precisa salvar contexto emocional
      if (state.data.complaint && (hasEmotionalContent || state.data.hasEmotionalContext)) {
        state.data.savedEmotionalContexts = state.data.savedEmotionalContexts || {};
        state.data.savedEmotionalContexts[state.data.therapy] = {
          complaint: state.data.complaint,
          therapy: state.data.therapy,
          savedAt: new Date(),
          hasEmotionalContext: true
        };
        this.logger.info('EMOTIONAL_CONTEXT_SAVED', { 
          fromTherapy: state.data.therapy, 
          toTherapy: extracted.therapy,
          complaint: state.data.complaint 
        });
      }
      // Limpa dados técnicos da terapia anterior
      state.data.complaint = null;
      state.data.age = null;
      state.data.period = null;
      state.data.hasEmotionalContext = false;
      extracted.contextRestored = false;
    } 
    // Se voltou para uma terapia que tinha contexto salvo
    else if (extracted.therapy && state.data.savedEmotionalContexts?.[extracted.therapy]) {
      const saved = state.data.savedEmotionalContexts[extracted.therapy];
      const hoursPassed = (Date.now() - new Date(saved.savedAt).getTime()) / (1000 * 60 * 60);
      // Restaura se foi há menos de 2 horas e não tem complaint atual
      if (hoursPassed < 2 && !state.data.complaint && !extracted.complaint) {
        state.data.complaint = saved.complaint;
        state.data.hasEmotionalContext = true;
        extracted.contextRestored = true;
        extracted.restoredTherapy = extracted.therapy;
        this.logger.info('EMOTIONAL_CONTEXT_RESTORED', { 
          therapy: extracted.therapy,
          complaint: saved.complaint, 
          hoursPassed 
        });
      }
    }
    
    // Marca se a queixa atual tem conteúdo emocional
    if (hasEmotionalContent && extracted.complaint) {
      state.data.hasEmotionalContext = true;
    }
    
    // 4. Merge entities (preserva dados existentes)
    state.data = { ...state.data, ...extracted };
    state.history.push({ role: 'user', text, timestamp: new Date() });
    
    // 5. Determina stage
    state.stage = this.determineStage(state.data);
    
    // 6. Gera resposta ou busca slots
    let response;
    if (state.stage === 'ready') {
      response = await this.handleBooking(state, lead);
    } else {
      response = await this.generateResponse(state, extracted);
    }
    
    // 7. Salva state (ChatContext = conversa atual)
    state.history.push({ role: 'assistant', text: response, timestamp: new Date() });
    await this.saveState(lead._id, state);
    
    // 8. 🔄 Persiste dados extraídos no Lead (LeadContext = dados acumulados)
    await this.persistToLead(lead._id, state.data);
    
    return { command: 'SEND_MESSAGE', payload: { text: response } };
  }

  detectEmotionalContent(text) {
    const lower = text.toLowerCase();
    return EMOTIONAL_MARKERS.some(marker => lower.includes(marker));
  }

  async classify(text, state) {
    // Tenta LLM primeiro
    try {
      const result = await analyzeLeadMessage({ text, history: state.history.slice(-5) });
      const info = result?.extractedInfo || {};
      
      const therapy = this.normalizeTherapy(info.especialidade || info.therapy);
      const complaint = info.queixa || info.complaint;
      const age = this.parseAge(info.idade || info.age);
      const period = this.normalizePeriod(info.disponibilidade || info.period);
      const intent = info.intent || 'general';
      
      if (therapy || complaint || age || period) {
        this.logger.debug('LLM_CLASSIFY_SUCCESS', { therapy, complaint, age, period, intent });
        return { therapy, complaint, age, period, intent };
      }
    } catch (e) {
      this.logger.debug('LLM_CLASSIFY_FAILED', { error: e.message });
    }
    
    // Fallback: THERAPY_MAP + regex simples
    return this.classifyFallback(text);
  }

  classifyFallback(text) {
    const lower = text.toLowerCase();
    
    // Detecta terapia pelo mapa
    let therapy = null;
    for (const [keyword, mapped] of Object.entries(THERAPY_MAP)) {
      if (lower.includes(keyword)) {
        therapy = mapped;
        break;
      }
    }
    
    // Extrai idade
    let age = null;
    const ageMatch = text.match(/\b(\d{1,2})\s*(?:anos?|a)\b/i);
    if (ageMatch) age = parseInt(ageMatch[1], 10);
    
    // Extrai período
    let period = null;
    if (/manh[ãa]|cedo/i.test(lower)) period = 'manha';
    else if (/tarde/i.test(lower)) period = 'tarde';
    else if (/noite/i.test(lower)) period = 'noite';
    
    // Detecta intent de mudança de assunto
    let intent = 'general';
    if (/pre[çc]o|valor|custa|quanto/i.test(lower)) intent = 'change_subject';
    else if (/endere[çc]o|onde|local|fica/i.test(lower)) intent = 'change_subject';
    else if (/plano|conv[êe]nio|unimed|amil|bradesco/i.test(lower)) intent = 'change_subject';
    
    this.logger.debug('CLASSIFY_FALLBACK', { therapy, age, period, intent });
    return { therapy, age, period, intent };
  }

  determineStage(data) {
    if (!data.therapy) return 'ask_therapy';
    if (!data.complaint) return 'ask_complaint';
    if (!data.age) return 'ask_age';
    if (!data.period) return 'ask_period';
    return 'ready';
  }

  async generateResponse(state, extracted) {
    const { therapy, savedEmotionalContexts, contextRestored, hasEmotionalContext } = state.data;
    const { intent, restoredTherapy } = extracted;
    
    // 🎭 RETOMADA EMPÁTICA: Se voltou para uma terapia com contexto salvo
    if (contextRestored && restoredTherapy && savedEmotionalContexts?.[restoredTherapy]) {
      const saved = savedEmotionalContexts[restoredTherapy];
      const therapyNames = {
        'fonoaudiologia': 'fonoaudiologia',
        'psicologia': 'psicologia', 
        'fisioterapia': 'fisioterapia'
      };
      return `Entendo, vamos voltar a falar sobre ${therapyNames[restoredTherapy]} 💚\n\nAntes você mencionou: "${saved.complaint}". Isso realmente parece importante. Me conta mais sobre como isso está afetando vocês hoje?`;
    }
    
    // Se mudou de assunto no meio, responde o assunto e retoma a pergunta atual
    if (intent === 'change_subject' && state.stage !== 'ask_therapy') {
      const subjectAnswer = this.getSubjectAnswer(intent);
      const resumeQuestion = this.getStageQuestion(state.stage);
      return `${subjectAnswer}\n\n${resumeQuestion}`;
    }
    
    return this.getStageQuestion(state.stage);
  }

  getStageQuestion(stage) {
    const questions = {
      ask_therapy: 'Olá! Bem-vindo à Fono Inova 💚\n\nPara qual especialidade você precisa de atendimento?\n• Fonoaudiologia\n• Psicologia\n• Fisioterapia',
      ask_complaint: 'Perfeito! Me conta rapidinho: qual a situação principal que vocês estão vivenciando?',
      ask_age: 'Qual a idade do paciente?',
      ask_period: 'Qual período prefere? Manhã, tarde ou noite?'
    };
    return questions[stage] || 'Como posso ajudar? 💚';
  }

  getSubjectAnswer(intent) {
    const answers = {
      change_subject: 'Trabalhamos com reembolso (você paga e solicita na operadora) 💚\n\nValores:\n• Sessão avulsa: R$ 200\n• Pacote 4x: R$ 180 cada'
    };
    return answers[intent] || 'Entendo! 💚';
  }

  async handleBooking(state, lead) {
    const { therapy, period, age } = state.data;
    
    try {
      this.logger.info('FETCHING_SLOTS', { therapy, period, age });
      
      const slots = await findAvailableSlots({ 
        therapyArea: therapy, 
        preferredPeriod: period, 
        patientAge: age 
      });
      
      if (slots?.primary?.length > 0) {
        const slotsText = slots.primary.slice(0, 4).map(s => 
          `• ${s.day} às ${s.time} (${s.doctorName || 'Profissional'})`
        ).join('\n');
        
        // Salva slots no lead para próxima interação
        await Leads.findByIdAndUpdate(lead._id, {
          $set: {
            pendingSchedulingSlots: slots,
            'autoBookingContext.lastOfferedSlots': slots,
            'autoBookingContext.active': true,
            'autoBookingContext.therapyArea': therapy,
            'autoBookingContext.preferredPeriod': period
          }
        });
        
        this.logger.info('SLOTS_FOUND', { count: slots.primary.length, therapy });
        return `Encontrei essas opções para ${therapy}:\n\n${slotsText}\n\nQual funciona melhor? 💚`;
      }
      
      this.logger.info('NO_SLOTS', { therapy, period });
      return `No momento não encontrei vagas para ${therapy} no período da ${period}. Nossa equipe vai entrar em contato para encontrar o melhor horário! 💚`;
    } catch (e) {
      this.logger.error('BOOKING_ERROR', { error: e.message, therapy, period });
      return 'Vou verificar os horários disponíveis e já te retorno! 💚';
    }
  }

  async persistToLead(leadId, data) {
    // Persiste dados estruturados no Lead (visão acumulada do lead)
    const extractedInfo = {
      therapyArea: data.therapy,
      complaint: data.complaint,
      age: data.age,
      period: data.period,
      hasEmotionalContext: data.hasEmotionalContext,
      savedEmotionalContexts: data.savedEmotionalContexts,
      extractedAt: new Date()
    };
    
    try {
      await updateExtractedInfo(leadId, extractedInfo);
      this.logger.debug('LEAD_CONTEXT_UPDATED', { leadId: leadId?.toString(), therapy: data.therapy });
    } catch (e) {
      this.logger.error('LEAD_CONTEXT_UPDATE_FAILED', { error: e.message, leadId: leadId?.toString() });
    }
  }

  async loadState(leadId) {
    const ctx = await ChatContext.findOne({ lead: leadId }).lean();
    const defaultState = { 
      stage: 'ask_therapy', 
      data: { therapy: null, complaint: null, age: null, period: null }, 
      history: [] 
    };
    return ctx?.conversationState || defaultState;
  }

  async saveState(leadId, state) {
    await ChatContext.findOneAndUpdate(
      { lead: leadId },
      { $set: { conversationState: state, lastContactAt: new Date() } },
      { upsert: true }
    );
  }

  normalizeTherapy(therapy) {
    if (!therapy) return null;
    const normalized = therapy.toLowerCase().trim();
    return VALID_THERAPIES.find(t => normalized.includes(t)) || null;
  }

  normalizePeriod(period) {
    if (!period) return null;
    const p = period.toLowerCase().trim();
    if (p.includes('manha') || p.includes('manhã') || p.includes('cedo')) return 'manha';
    if (p.includes('tarde')) return 'tarde';
    if (p.includes('noite')) return 'noite';
    return null;
  }

  parseAge(age) {
    if (!age) return null;
    const num = parseInt(age, 10);
    return isNaN(num) || num < 0 || num > 120 ? null : num;
  }
}

export default WhatsAppOrchestrator;
