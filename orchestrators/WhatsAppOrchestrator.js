import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';

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
    
    this.logger.info('V5_START', { leadId, text: text.substring(0, 60) });

    try {
      // 1. Carrega state do lead
      let state = await this.loadState(lead);
      this.logger.info('V5_STATE', { leadId, stage: state.stage, therapy: state.data.therapy, age: state.data.age });
      
      // 2. Classifica mensagem
      const extracted = await this.classify(text);
      this.logger.info('V5_CLASSIFY', { leadId, extractedTherapy: extracted.therapy, intent: extracted.intent });
      
      // 3. 🛡️ PROTEÇÃO: Se temos dados salvos e o novo não trouxe, preserva
      if (state.data.therapy && !extracted.therapy) {
        extracted.therapy = state.data.therapy;
        this.logger.debug('V5_PRESERVE_THERAPY', { leadId, therapy: state.data.therapy });
      }
      if (state.data.age && !extracted.age) {
        extracted.age = state.data.age;
        this.logger.debug('V5_PRESERVE_AGE', { leadId, age: state.data.age });
      }
      if (state.data.period && !extracted.period) {
        extracted.period = state.data.period;
        this.logger.debug('V5_PRESERVE_PERIOD', { leadId, period: state.data.period });
      }
      
      // 4. 🛡️ PROTEÇÃO DE CONTEXTO EMOCIONAL
      const hasEmotionalContent = this.detectEmotionalContent(text);
      
      if (extracted.therapy && state.data.therapy && extracted.therapy !== state.data.therapy) {
        this.logger.info('V5_THERAPY_CHANGE', { leadId, from: state.data.therapy, to: extracted.therapy });
        
        if (state.data.complaint && (hasEmotionalContent || state.data.hasEmotionalContext)) {
          state.data.savedEmotionalContexts = state.data.savedEmotionalContexts || {};
          state.data.savedEmotionalContexts[state.data.therapy] = { 
            complaint: state.data.complaint, 
            savedAt: new Date() 
          };
          this.logger.info('V5_CONTEXT_SAVED', { leadId, therapy: state.data.therapy });
        }
        state.data.complaint = null;
        state.data.hasEmotionalContext = false;
      } else if (extracted.therapy && state.data.savedEmotionalContexts?.[extracted.therapy]) {
        const saved = state.data.savedEmotionalContexts[extracted.therapy];
        const hoursPassed = (Date.now() - new Date(saved.savedAt).getTime()) / (1000 * 60 * 60);
        if (hoursPassed < 2 && !extracted.complaint) {
          extracted.complaint = saved.complaint;
          extracted.contextRestored = true;
          this.logger.info('V5_CONTEXT_RESTORED', { leadId, therapy: extracted.therapy });
        }
      }
      
      if (hasEmotionalContent && extracted.complaint) {
        state.data.hasEmotionalContext = true;
      }
      
      // 5. Merge entities
      state.data = { ...state.data, ...extracted };
      state.history.push({ role: 'user', text, timestamp: new Date() });
      
      // 6. Determina stage
      const previousStage = state.stage;
      state.stage = this.determineStage(state.data);
      if (previousStage !== state.stage) {
        this.logger.info('V5_STAGE_CHANGE', { leadId, from: previousStage, to: state.stage });
      }
      
      // 7. Gera resposta
      let response = state.stage === 'ready' 
        ? await this.handleBooking(state, lead) 
        : await this.generateResponse(state, extracted);
      
      this.logger.info('V5_RESPONSE', { leadId, stage: state.stage, length: response.length });
      
      // 8. Salva
      state.history.push({ role: 'assistant', text: response, timestamp: new Date() });
      await this.saveState(lead._id, state);
      
      this.logger.info('V5_COMPLETE', { leadId, timeMs: Date.now() - startTime });
      return { command: 'SEND_MESSAGE', payload: { text: response } };
      
    } catch (error) {
      this.logger.error('V5_ERROR', { leadId, error: error.message });
      return { command: 'SEND_MESSAGE', payload: { text: 'Como posso te ajudar? 💚' } };
    }
  }

  detectEmotionalContent(text) {
    if (!text) return false;
    return EMOTIONAL_MARKERS.some(marker => text.toLowerCase().includes(marker));
  }

  async classify(text) {
    // Tenta LLM
    try {
      const result = await analyzeLeadMessage({ text, history: [] });
      const info = result?.extractedInfo || {};
      const therapy = this.normalizeTherapy(info.especialidade || info.therapy);
      const complaint = info.queixa || info.complaint;
      const age = this.parseAge(info.idade || info.age);
      const period = this.normalizePeriod(info.disponibilidade || info.period);
      
      if (therapy || complaint || age || period) {
        return { therapy, complaint, age, period, intent: info.intent || 'general', _source: 'llm' };
      }
    } catch (e) {
      this.logger.error('V5_LLM_FAIL', { error: e.message });
    }
    
    // Fallback
    return { ...this.classifyFallback(text), _source: 'fallback' };
  }

  classifyFallback(text) {
    const lower = text.toLowerCase();
    let therapy = null;
    for (const [k, v] of Object.entries(THERAPY_MAP)) if (lower.includes(k)) { therapy = v; break; }
    let age = null; const m = text.match(/\b(\d{1,2})\s*(?:anos?|a)\b/i); if (m) age = parseInt(m[1], 10);
    let period = /manh[ãa]|cedo/i.test(lower) ? 'manha' : /tarde/i.test(lower) ? 'tarde' : /noite/i.test(lower) ? 'noite' : null;
    let intent = /pre[çc]o|valor|custa|quanto/i.test(lower) ? 'change_subject' : /endere[çc]o|onde|local/i.test(lower) ? 'change_subject' : /plano|conv[êe]nio/i.test(lower) ? 'change_subject' : 'general';
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
    // 🎭 RETOMADA EMPÁTICA
    if (extracted.contextRestored && state.data.therapy && state.data.savedEmotionalContexts?.[state.data.therapy]) {
      const saved = state.data.savedEmotionalContexts[state.data.therapy];
      return `Entendo, vamos voltar a falar sobre ${state.data.therapy} 💚\n\nAntes você mencionou: "${saved.complaint}". Me conta mais sobre como isso está afetando vocês?`;
    }
    
    // Change subject: responde mas NÃO muda de stage
    if (extracted.intent === 'change_subject') {
      const stageQuestion = this.getStageQuestion(state.stage);
      if (state.stage === 'ask_therapy') {
        return `Trabalhamos com reembolso 💚\n• Sessão: R$ 200\n• Pacote 4x: R$ 180\n\n${stageQuestion}`;
      }
      return `Trabalhamos com reembolso 💚\n• Sessão: R$ 200\n• Pacote 4x: R$ 180\n\n${stageQuestion}`;
    }
    
    return this.getStageQuestion(state.stage);
  }

  getStageQuestion(stage) {
    const q = { 
      ask_therapy: 'Olá! Bem-vindo à Fono Inova 💚\n\nQual especialidade?\n• Fonoaudiologia\n• Psicologia\n• Fisioterapia', 
      ask_complaint: 'Perfeito! Me conta rapidinho: qual a situação principal?', 
      ask_age: 'Qual a idade do paciente?', 
      ask_period: 'Qual período prefere? Manhã, tarde ou noite?' 
    };
    return q[stage] || 'Como posso ajudar? 💚';
  }

  async handleBooking(state, lead) {
    const { therapy, period, age } = state.data;
    const leadId = lead._id?.toString();
    this.logger.info('V5_BOOKING', { leadId, therapy, period, age });
    
    try {
      const slots = await findAvailableSlots({ therapyArea: therapy, preferredPeriod: period, patientAge: age });
      
      if (slots?.primary?.length > 0) {
        const txt = slots.primary.slice(0, 4).map(s => `• ${s.day} às ${s.time} (${s.doctorName || 'Prof.'})`).join('\n');
        await Leads.findByIdAndUpdate(lead._id, { 
          $set: { 
            pendingSchedulingSlots: slots, 
            'autoBookingContext.active': true, 
            'autoBookingContext.therapyArea': therapy 
          } 
        });
        return `Encontrei essas opções para ${therapy}:\n\n${txt}\n\nQual funciona melhor? 💚`;
      }
      return `No momento não encontrei vagas para ${therapy}. Nossa equipe vai entrar em contato! 💚`;
    } catch (e) {
      this.logger.error('V5_BOOKING_ERROR', { leadId, error: e.message });
      return 'Vou verificar os horários e já te retorno! 💚';
    }
  }

  async loadState(lead) {
    const leadId = lead?._id?.toString();
    
    try {
      // Tenta carregar do lead.lastExtractedInfo
      const savedState = lead?.lastExtractedInfo?.conversationState;
      
      if (savedState && savedState.data) {
        this.logger.debug('V5_STATE_FROM_LEAD', { leadId, stage: savedState.stage });
        return {
          stage: savedState.stage || 'ask_therapy',
          data: {
            therapy: savedState.data.therapy || lead?.therapyArea || null,
            complaint: savedState.data.complaint || lead?.primaryComplaint || null,
            age: savedState.data.age || lead?.patientInfo?.age || null,
            period: savedState.data.period || lead?.pendingPreferredPeriod || null,
            savedEmotionalContexts: savedState.data.savedEmotionalContexts || {},
            hasEmotionalContext: savedState.data.hasEmotionalContext || false
          },
          history: savedState.history || []
        };
      }
      
      // Estado inicial a partir do lead
      return {
        stage: 'ask_therapy',
        data: {
          therapy: lead?.therapyArea || null,
          complaint: lead?.primaryComplaint || null,
          age: lead?.patientInfo?.age || null,
          period: lead?.pendingPreferredPeriod || null,
          savedEmotionalContexts: {},
          hasEmotionalContext: false
        },
        history: []
      };
    } catch (e) {
      this.logger.error('V5_LOAD_ERROR', { leadId, error: e.message });
      return { stage: 'ask_therapy', data: { therapy: null, complaint: null, age: null, period: null, savedEmotionalContexts: {}, hasEmotionalContext: false }, history: [] };
    }
  }

  async saveState(leadId, state) {
    try {
      await Leads.findByIdAndUpdate(leadId, {
        $set: {
          'lastExtractedInfo.conversationState': state,
          'lastExtractedInfo.therapyArea': state.data.therapy,
          'lastExtractedInfo.complaint': state.data.complaint,
          'lastExtractedInfo.age': state.data.age,
          'lastExtractedInfo.period': state.data.period,
          'lastExtractedInfo.savedEmotionalContexts': state.data.savedEmotionalContexts,
          'lastExtractedInfo.updatedAt': new Date()
        }
      });
      this.logger.debug('V5_SAVED', { leadId: leadId?.toString(), stage: state.stage });
    } catch (e) {
      this.logger.error('V5_SAVE_ERROR', { leadId: leadId?.toString(), error: e.message });
    }
  }

  normalizeTherapy(t) { return t ? VALID_THERAPIES.find(v => t.toLowerCase().includes(v)) || null : null; }
  normalizePeriod(p) { if (!p) return null; const x = p.toLowerCase(); return x.includes('manha') || x.includes('manhã') ? 'manha' : x.includes('tarde') ? 'tarde' : x.includes('noite') ? 'noite' : null; }
  parseAge(a) { const n = parseInt(a, 10); return isNaN(n) || n < 0 || n > 120 ? null : n; }
}

export default WhatsAppOrchestrator;
