import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import { updateExtractedInfo, enrichLeadContext } from '../services/leadContext.js';

const THERAPY_MAP = {
  'ansiedade': 'psicologia', 'depressão': 'psicologia', 'tdah': 'psicologia',
  'psicologia': 'psicologia', 'psicólogo': 'psicologia', 'psicologa': 'psicologia',
  'emocional': 'psicologia', 'comportamento': 'psicologia',
  'autismo': 'fonoaudiologia', 'tea': 'fonoaudiologia', 'fala': 'fonoaudiologia',
  'gagueira': 'fonoaudiologia', 'não fala': 'fonoaudiologia', 
  'atraso de fala': 'fonoaudiologia', 'fonoaudiologia': 'fonoaudiologia', 'fono': 'fonoaudiologia',
  'linguagem': 'fonoaudiologia', 'pronúncia': 'fonoaudiologia',
  'desvio': 'fisioterapia', 'coluna': 'fisioterapia', 'postura': 'fisioterapia',
  'dor': 'fisioterapia', 'lesão': 'fisioterapia', 'reabilitação': 'fisioterapia',
  'fisioterapia': 'fisioterapia', 'fisio': 'fisioterapia', 'osteopatia': 'fisioterapia', 'avc': 'fisioterapia'
};

const EMOTIONAL_MARKERS = ['desespero', 'desesperada', 'desesperado', 'não aguento', 'não suporto', 'me mata', 'me consome', 'sofrimento', 'sofro', 'angustia', 'medo', 'choro', 'depressão', 'ansiedade', 'pânico', 'estresse', 'não sei o que fazer', 'perdida', 'sem saída'];
const VALID_THERAPIES = ['fonoaudiologia', 'psicologia', 'fisioterapia'];

export class WhatsAppOrchestrator {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestrator');
  }

  async process({ lead, message, services }) {
    const startTime = Date.now();
    const leadId = lead?._id?.toString() || 'unknown';
    const text = message?.content || message?.text || '';
    
    this.logger.info('V5_PROCESS_START', { leadId, textLength: text.length, textPreview: text.substring(0, 80).replace(/\n/g, ' ') });

    try {
      // 1. Carrega state do LeadContext
      let state = await this.loadState(lead._id);
      this.logger.info('V5_STATE_LOADED', { leadId, currentStage: state.stage, currentTherapy: state.data.therapy, historyLength: state.history.length });
      
      // 2. Classifica mensagem
      const extracted = await this.classify(text, state);
      this.logger.info('V5_CLASSIFY_RESULT', { leadId, extractedTherapy: extracted.therapy, extractedAge: extracted.age, extractedPeriod: extracted.period, intent: extracted.intent, source: extracted._source });
      
      // 3. 🛡️ PROTEÇÃO DE CONTEXTO EMOCIONAL
      const hasEmotionalContent = this.detectEmotionalContent(text);
      
      if (extracted.therapy && state.data.therapy && extracted.therapy !== state.data.therapy) {
        this.logger.info('V5_THERAPY_CHANGE', { leadId, from: state.data.therapy, to: extracted.therapy, hasEmotional: !!(state.data.complaint && (hasEmotionalContent || state.data.hasEmotionalContext)) });
        
        if (state.data.complaint && (hasEmotionalContent || state.data.hasEmotionalContext)) {
          state.data.savedEmotionalContexts = state.data.savedEmotionalContexts || {};
          state.data.savedEmotionalContexts[state.data.therapy] = { complaint: state.data.complaint, therapy: state.data.therapy, savedAt: new Date(), hasEmotionalContext: true };
          this.logger.info('V5_CONTEXT_SAVED', { leadId, fromTherapy: state.data.therapy, complaint: state.data.complaint?.substring(0, 60) });
        }
        state.data.complaint = null; state.data.age = null; state.data.period = null; state.data.hasEmotionalContext = false; extracted.contextRestored = false;
      } else if (extracted.therapy && state.data.savedEmotionalContexts?.[extracted.therapy]) {
        const saved = state.data.savedEmotionalContexts[extracted.therapy];
        const hoursPassed = (Date.now() - new Date(saved.savedAt).getTime()) / (1000 * 60 * 60);
        if (hoursPassed < 2 && !state.data.complaint && !extracted.complaint) {
          state.data.complaint = saved.complaint; state.data.hasEmotionalContext = true; extracted.contextRestored = true; extracted.restoredTherapy = extracted.therapy;
          this.logger.info('V5_CONTEXT_RESTORED', { leadId, therapy: extracted.therapy, hoursPassed: Math.round(hoursPassed * 10) / 10 });
        }
      }
      if (hasEmotionalContent && extracted.complaint) state.data.hasEmotionalContext = true;
      
      // 4. Merge e determina stage
      state.data = { ...state.data, ...extracted };
      state.history.push({ role: 'user', text, timestamp: new Date() });
      const previousStage = state.stage;
      state.stage = this.determineStage(state.data);
      if (previousStage !== state.stage) this.logger.info('V5_STAGE_CHANGE', { leadId, from: previousStage, to: state.stage });
      
      // 5. Gera resposta
      let response = state.stage === 'ready' ? await this.handleBooking(state, lead) : await this.generateResponse(state, extracted);
      this.logger.info('V5_RESPONSE_READY', { leadId, stage: state.stage, responseLength: response.length });
      
      // 6. Salva state no LeadContext
      state.history.push({ role: 'assistant', text: response, timestamp: new Date() });
      await this.saveState(lead._id, state);
      
      this.logger.info('V5_COMPLETE', { leadId, totalTimeMs: Date.now() - startTime, finalStage: state.stage });
      return { command: 'SEND_MESSAGE', payload: { text: response } };
      
    } catch (error) {
      this.logger.error('V5_ERROR', { leadId, error: error.message, stack: error.stack?.split('\n')[0], totalTimeMs: Date.now() - startTime });
      return { command: 'SEND_MESSAGE', payload: { text: 'Como posso te ajudar? 💚' }, meta: { error: true } };
    }
  }

  detectEmotionalContent(text) {
    if (!text) return false;
    return EMOTIONAL_MARKERS.some(marker => text.toLowerCase().includes(marker));
  }

  async classify(text, state) {
    try {
      const result = await analyzeLeadMessage({ text, history: state.history.slice(-5) });
      const info = result?.extractedInfo || {};
      const therapy = this.normalizeTherapy(info.especialidade || info.therapy);
      const complaint = info.queixa || info.complaint;
      const age = this.parseAge(info.idade || info.age);
      const period = this.normalizePeriod(info.disponibilidade || info.period);
      if (therapy || complaint || age || period) return { therapy, complaint, age, period, intent: info.intent || 'general', _source: 'llm' };
    } catch (e) {
      this.logger.error('V5_LLM_ERROR', { error: e.message });
    }
    return { ...this.classifyFallback(text), _source: 'fallback' };
  }

  classifyFallback(text) {
    const lower = text.toLowerCase();
    let therapy = null;
    for (const [k, v] of Object.entries(THERAPY_MAP)) if (lower.includes(k)) { therapy = v; break; }
    let age = null; const m = text.match(/\b(\d{1,2})\s*(?:anos?|a)\b/i); if (m) age = parseInt(m[1], 10);
    let period = /manh[ãa]|cedo/i.test(lower) ? 'manha' : /tarde/i.test(lower) ? 'tarde' : /noite/i.test(lower) ? 'noite' : null;
    let intent = /pre[çc]o|valor|custa|quanto/i.test(lower) ? 'change_subject' : /endere[çc]o|onde|local|fica/i.test(lower) ? 'change_subject' : /plano|conv[êe]nio/i.test(lower) ? 'change_subject' : 'general';
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
    const { savedEmotionalContexts, contextRestored } = state.data;
    if (contextRestored && extracted.restoredTherapy && savedEmotionalContexts?.[extracted.restoredTherapy]) {
      const saved = savedEmotionalContexts[extracted.restoredTherapy];
      this.logger.info('V5_EMPATHETIC_RESPONSE', { restoredTherapy: extracted.restoredTherapy });
      return `Entendo, vamos voltar a falar sobre ${extracted.restoredTherapy} 💚\n\nAntes você mencionou: "${saved.complaint}". Isso realmente parece importante. Me conta mais sobre como isso está afetando vocês hoje?`;
    }
    if (extracted.intent === 'change_subject' && state.stage !== 'ask_therapy') {
      return `Trabalhamos com reembolso 💚\n• Sessão avulsa: R$ 200\n• Pacote 4x: R$ 180\n\n${this.getStageQuestion(state.stage)}`;
    }
    return this.getStageQuestion(state.stage);
  }

  getStageQuestion(stage) {
    const q = { ask_therapy: 'Olá! Bem-vindo à Fono Inova 💚\n\nQual especialidade?\n• Fonoaudiologia\n• Psicologia\n• Fisioterapia', ask_complaint: 'Perfeito! Me conta rapidinho: qual a situação principal?', ask_age: 'Qual a idade do paciente?', ask_period: 'Qual período prefere? Manhã, tarde ou noite?' };
    return q[stage] || 'Como posso ajudar? 💚';
  }

  async handleBooking(state, lead) {
    const { therapy, period, age } = state.data;
    const leadId = lead._id?.toString();
    this.logger.info('V5_BOOKING', { leadId, therapy, period, age });
    try {
      const slots = await findAvailableSlots({ therapyArea: therapy, preferredPeriod: period, patientAge: age });
      this.logger.info('V5_SLOTS_RESULT', { leadId, count: slots?.primary?.length || 0 });
      if (slots?.primary?.length > 0) {
        const txt = slots.primary.slice(0, 4).map(s => `• ${s.day} às ${s.time} (${s.doctorName || 'Profissional'})`).join('\n');
        await Leads.findByIdAndUpdate(lead._id, { $set: { pendingSchedulingSlots: slots, 'autoBookingContext.active': true, 'autoBookingContext.therapyArea': therapy } });
        return `Encontrei essas opções para ${therapy}:\n\n${txt}\n\nQual funciona melhor? 💚`;
      }
      return `No momento não encontrei vagas para ${therapy}. Nossa equipe vai entrar em contato! 💚`;
    } catch (e) {
      this.logger.error('V5_BOOKING_ERROR', { leadId, error: e.message });
      return 'Vou verificar os horários e já te retorno! 💚';
    }
  }

  async loadState(leadId) {
    try {
      // Carrega do LeadContext (enrichLeadContext retorna contexto completo)
      const context = await enrichLeadContext(leadId);
      const lead = await Leads.findById(leadId).lean();
      
      // Extrai estado salvo em lastExtractedInfo ou retorna default
      const savedState = lead?.lastExtractedInfo?.conversationState;
      
      if (savedState) {
        this.logger.debug('V5_STATE_FROM_LEAD', { leadId: leadId?.toString(), stage: savedState.stage });
        return savedState;
      }
      
      // Constrói estado inicial a partir do contexto do lead
      const initialState = {
        stage: 'ask_therapy',
        data: {
          therapy: lead?.therapyArea || null,
          complaint: lead?.primaryComplaint || null,
          age: lead?.patientInfo?.age || null,
          period: lead?.pendingPreferredPeriod || null,
          savedEmotionalContexts: lead?.lastExtractedInfo?.savedEmotionalContexts || {}
        },
        history: context?.conversationHistory?.slice(-10) || []
      };
      
      this.logger.debug('V5_STATE_INITIAL', { leadId: leadId?.toString() });
      return initialState;
    } catch (e) {
      this.logger.error('V5_LOAD_STATE_ERROR', { leadId: leadId?.toString(), error: e.message });
      return { stage: 'ask_therapy', data: { therapy: null, complaint: null, age: null, period: null, savedEmotionalContexts: {} }, history: [] };
    }
  }

  async saveState(leadId, state) {
    try {
      // Salva em lastExtractedInfo do Lead via updateExtractedInfo
      const extractedInfo = {
        conversationState: state,
        therapyArea: state.data.therapy,
        complaint: state.data.complaint,
        age: state.data.age,
        period: state.data.period,
        hasEmotionalContext: state.data.hasEmotionalContext,
        savedEmotionalContexts: state.data.savedEmotionalContexts,
        stage: state.stage,
        updatedAt: new Date()
      };
      
      await updateExtractedInfo(leadId, extractedInfo);
      this.logger.debug('V5_STATE_SAVED_TO_LEAD', { leadId: leadId?.toString(), stage: state.stage });
    } catch (e) {
      this.logger.error('V5_SAVE_STATE_ERROR', { leadId: leadId?.toString(), error: e.message });
      throw e;
    }
  }

  normalizeTherapy(t) { return t ? VALID_THERAPIES.find(v => t.toLowerCase().includes(v)) || null : null; }
  normalizePeriod(p) { if (!p) return null; const x = p.toLowerCase(); return x.includes('manha') || x.includes('manhã') ? 'manha' : x.includes('tarde') ? 'tarde' : x.includes('noite') ? 'noite' : null; }
  parseAge(a) { const n = parseInt(a, 10); return isNaN(n) || n < 0 || n > 120 ? null : n; }
}

export default WhatsAppOrchestrator;
