import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';

// Dados das terapias
const THERAPY_DATA = {
  fonoaudiologia: { name: 'Fonoaudiologia', emoji: '💬', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180' },
  psicologia: { name: 'Psicologia', emoji: '🧠', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180' },
  fisioterapia: { name: 'Fisioterapia', emoji: '🏃', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180' },
  terapia_ocupacional: { name: 'Terapia Ocupacional', emoji: '🤲', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180' },
  psicopedagogia: { name: 'Psicopedagogia', emoji: '📚', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180' },
  neuropsicologia: { name: 'Neuropsicologia', emoji: '🧩', price: 'Avaliação: R$ 400 | Retorno: R$ 250' },
  musicoterapia: { name: 'Musicoterapia', emoji: '🎵', price: 'Sessão: R$ 180 | Pacote 4x: R$ 160' },
  psicomotricidade: { name: 'Psicomotricidade', emoji: '🤸', price: 'Sessão: R$ 180 | Pacote 4x: R$ 160' },
  pediatria: { name: 'Pediatria', emoji: '👶', price: 'Consulta: R$ 250 | Retorno: R$ 180' },
  neuroped: { name: 'Neuropediatria', emoji: '🧠', price: 'Consulta: R$ 300 | Retorno: R$ 200' }
};

// Keywords para detecção
const THERAPY_KEYWORDS = {
  fonoaudiologia: ['fono','fala','gagueira','autismo','tea','linguagem','pronuncia','falar'],
  psicologia: ['psico','ansiedade','depressao','tdah','emocional','choro','medo','panico'],
  fisioterapia: ['fisio','dor','coluna','postura','joelho','avc','reabilitacao','osteopatia'],
  terapia_ocupacional: ['to','terapia ocupacional','sensorial','coordenacao'],
  psicopedagogia: ['psicopedagogia','dislexia','aprendizagem','escola','leitura'],
  neuropsicologia: ['neuropsico','avaliacao cognitiva','memoria','atencao'],
  musicoterapia: ['musica','musicoterapia','musical','som'],
  psicomotricidade: ['psicomotricidade','equilibrio','movimento','motricidade'],
  pediatria: ['pediatria','pediatra','desenvolvimento','acompanhamento pediatrico'],
  neuroped: ['neuroped','neurologista','neurologia','convulsao','epilepsia']
};

export class WhatsAppOrchestrator {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestrator');
  }

  async process({ lead, message }) {
    const startTime = Date.now();
    const leadId = lead?._id?.toString() || 'unknown';
    const text = message?.content || message?.text || '';
    
    this.logger.info('V5_START', { leadId, text: text.substring(0, 60) });

    try {
      let state = await this.loadState(lead);
      
      const extracted = this.extractFromText(text);
      
      // Preserva dados existentes
      if (state.data.therapy && !extracted.therapy) extracted.therapy = state.data.therapy;
      if (state.data.age && !extracted.age) extracted.age = state.data.age;
      if (state.data.period && !extracted.period) extracted.period = state.data.period;
      if (state.data.complaint && !extracted.complaint) extracted.complaint = state.data.complaint;
      
      const isPriceQuestion = /preco|valor|custa|quanto|reais|r\$/i.test(text);
      
      state.data = { ...state.data, ...extracted };
      state.history.push({ role: 'user', text, timestamp: new Date() });
      
      const prevStage = state.stage;
      state.stage = this.determineStage(state.data);
      if (prevStage !== state.stage) this.logger.info('V5_STAGE', { leadId, from: prevStage, to: state.stage });
      
      let response;
      if (isPriceQuestion) {
        response = this.handlePrice(state);
      } else if (state.stage === 'ready') {
        response = await this.handleBooking(state, lead);
      } else {
        response = this.generateResponse(state);
      }
      
      state.history.push({ role: 'assistant', text: response, timestamp: new Date() });
      await this.saveState(lead._id, state);
      
      this.logger.info('V5_COMPLETE', { leadId, timeMs: Date.now() - startTime });
      return { command: 'SEND_MESSAGE', payload: { text: response } };
      
    } catch (error) {
      this.logger.error('V5_ERROR', { leadId, error: error.message });
      return { command: 'SEND_MESSAGE', payload: { text: 'Oi! Sou a Amanda da Fono Inova 💚 Me conta como posso te ajudar?' } };
    }
  }

  extractFromText(text) {
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const result = { therapy: null, age: null, complaint: null, period: null };
    
    // Terapia
    for (const [therapy, keywords] of Object.entries(THERAPY_KEYWORDS)) {
      if (keywords.some(k => lower.includes(k))) { result.therapy = therapy; break; }
    }
    
    // Idade
    const ageMatch = text.match(/(\d+)\s*anos?/) || text.match(/tem\s*(\d+)\s*anos/);
    if (ageMatch) {
      const age = parseInt(ageMatch[1], 10);
      if (age >= 0 && age <= 120) result.age = age;
    }
    
    // Período
    if (/manha|cedo/i.test(lower)) result.period = 'manha';
    else if (/tarde/i.test(lower)) result.period = 'tarde';
    else if (/noite/i.test(lower)) result.period = 'noite';
    
    // Queixa (texto descritivo)
    const isQuestion = /^(qual|quanto|onde|como|voce|voces|tem|faz)/i.test(text.trim());
    if (!isQuestion && text.length > 10 && text.length < 200) {
      let complaint = text.replace(/^(oi|ola|bom dia|boa tarde)[,\s]*/i, '').replace(/,?\s*(quanto|qual|preco).*/i, '').trim();
      if (complaint.length > 5) result.complaint = complaint;
    }
    
    return result;
  }

  determineStage(data) {
    if (!data.therapy) return 'ask_therapy';
    if (!data.complaint && !data.age) return 'ask_context';
    if (!data.age) return 'ask_age';
    if (!data.period) return 'ask_period';
    return 'ready';
  }

  generateResponse(state) {
    const { stage, data } = state;
    const therapy = THERAPY_DATA[data.therapy];
    
    if (stage === 'ask_therapy') {
      return `Oi! Sou a Amanda da Fono Inova 💚

Me conta: você está buscando atendimento para você ou para alguém da família? E qual situação vocês estão enfrentando?`;
    }
    
    if (stage === 'ask_context') {
      if (data.therapy === 'fonoaudiologia') {
        return `Entendi que é para fonoaudiologia 💬

Qual a idade e como está a comunicação? Ele fala algumas palavras, não fala ainda, ou tem dificuldade específica?`;
      }
      if (data.therapy === 'psicologia') {
        return `Sobre psicologia 🧠

É para você ou para um filho? Qual a idade? Me conta também como vocês estão se sentindo - é ansiedade, dificuldade para dormir, ou algo mais?`;
      }
      if (data.therapy === 'fisioterapia') {
        return `Para fisioterapia 🏃

Qual a idade e onde está sentindo dor? É algo recente ou já vem sentindo há um tempo?`;
      }
      return `Perfeito! Para ${therapy?.name || 'o atendimento'} ${therapy?.emoji || ''}

Qual a idade? E me conta um pouco mais sobre a situação.`;
    }
    
    if (stage === 'ask_age') return `E qual a idade? Isso ajuda a ver os profissionais mais indicados 💚`;
    if (stage === 'ask_period') return `Qual período funciona melhor? Manhã, tarde ou noite?`;
    
    return `Como posso ajudar? 💚`;
  }

  handlePrice(state) {
    const { data } = state;
    const therapy = THERAPY_DATA[data.therapy];
    
    if (therapy) {
      return `Claro! Para ${therapy.name} ${therapy.emoji}:

${therapy.price}

Trabalhamos com reembolso também - você paga e solicita no seu plano de saúde.

${data.period ? 'Vou verificar os horários!' : 'Qual período prefere? Manhã, tarde ou noite?'}`;
    }
    
    return `Os valores variam conforme a especialidade 💚

Sessões: R$ 180 a R$ 300
Pacotes: desconto de 10-20%

Me conta qual situação vocês estão enfrentando que aí consigo te passar o valor exato!`;
  }

  async handleBooking(state, lead) {
    const { therapy, period, age } = state.data;
    const leadId = lead._id?.toString();
    const therapyData = THERAPY_DATA[therapy];
    
    try {
      const slots = await findAvailableSlots({ therapyArea: therapy, preferredPeriod: period, patientAge: age });
      
      if (slots?.primary?.length > 0) {
        const txt = slots.primary.slice(0, 3).map(s => `• ${s.day} às ${s.time} com ${s.doctorName || 'profissional'}`).join('\n');
        await Leads.findByIdAndUpdate(lead._id, { 
          $set: { pendingSchedulingSlots: slots, 'autoBookingContext.active': true, 'autoBookingContext.therapyArea': therapy } 
        });
        return `Encontrei essas opções para ${therapyData?.name || therapy}:

${txt}

Qual funciona melhor? 💚`;
      }
      
      return `No momento não encontrei vagas para ${therapyData?.name || therapy} no período da ${period}.

Posso pedir para nossa equipe entrar em contato para encontrar o melhor horário?`;
    } catch (e) {
      this.logger.error('V5_BOOKING_ERROR', { leadId, error: e.message });
      return `Vou verificar os horários com nossa equipe e te retorno em breve! 💚`;
    }
  }

  async loadState(lead) {
    try {
      const saved = lead?.lastExtractedInfo?.conversationState;
      if (saved?.data) {
        return {
          stage: saved.stage || 'ask_therapy',
          data: {
            therapy: saved.data.therapy || lead?.therapyArea || null,
            complaint: saved.data.complaint || lead?.primaryComplaint || null,
            age: saved.data.age || lead?.patientInfo?.age || null,
            period: saved.data.period || lead?.pendingPreferredPeriod || null
          },
          history: saved.history || []
        };
      }
      return {
        stage: 'ask_therapy',
        data: { therapy: lead?.therapyArea || null, complaint: lead?.primaryComplaint || null, age: lead?.patientInfo?.age || null, period: lead?.pendingPreferredPeriod || null },
        history: []
      };
    } catch (e) {
      return { stage: 'ask_therapy', data: { therapy: null, complaint: null, age: null, period: null }, history: [] };
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
          'lastExtractedInfo.updatedAt': new Date()
        }
      });
    } catch (e) {
      this.logger.error('V5_SAVE_ERROR', { leadId: leadId?.toString(), error: e.message });
    }
  }
}

export default WhatsAppOrchestrator;
