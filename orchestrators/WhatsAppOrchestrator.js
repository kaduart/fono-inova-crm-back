import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import ChatContext from '../models/ChatContext.js';
import { detectAllFlags } from '../utils/flagsDetector.js';
import { detectAllTherapies } from '../utils/therapyDetector.js';

// Dados das terapias
const THERAPY_DATA = {
  fonoaudiologia: { name: 'Fonoaudiologia', emoji: '💬', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  psicologia: { name: 'Psicologia', emoji: '🧠', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  fisioterapia: { name: 'Fisioterapia', emoji: '🏃', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  terapia_ocupacional: { name: 'Terapia Ocupacional', emoji: '🤲', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  psicopedagogia: { name: 'Psicopedagogia', emoji: '📚', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  neuropsicologia: { name: 'Neuropsicologia', emoji: '🧩', price: 'Avaliação: R$ 400 | Retorno: R$ 250' },
  musicoterapia: { name: 'Musicoterapia', emoji: '🎵', price: 'Sessão: R$ 180 | Pacote 4x: R$ 160 cada' },
  psicomotricidade: { name: 'Psicomotricidade', emoji: '🤸', price: 'Sessão: R$ 180 | Pacote 4x: R$ 160 cada' }
};

const DETECTOR_MAP = {
  'speech': 'fonoaudiologia',
  'tongue_tie': 'fonoaudiologia',
  'psychology': 'psicologia',
  'physiotherapy': 'fisioterapia',
  'occupational': 'terapia_ocupacional',
  'psychopedagogy': 'psicopedagogia',
  'neuropsychological': 'neuropsicologia',
  'music': 'musicoterapia'
};

export class WhatsAppOrchestrator {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestrator');
  }

  async process({ lead, message }) {
    const leadId = lead?._id?.toString() || 'unknown';
    const text = message?.content || message?.text || '';
    
    this.logger.info('V5_START', { leadId, text: text.substring(0, 80) });

    try {
      // 1. Carrega memória acumulada
      const memory = await this.loadMemory(lead._id);
      
      // 2. Detecta NOVOS dados da mensagem atual
      const detected = this.detectar(text, lead);
      
      // 3. FUNDE (merge): acumula, nunca apaga
      const context = this.fundir(memory, detected);
      this.logger.info('V5_CONTEXT', { leadId, therapy: context.therapy, age: context.age, period: context.period });
      
      // 4. Conversa fluida (lógica única)
      const response = this.conversar(text, context);
      
      // 5. Persiste
      await this.saveMemory(lead._id, context);
      
      this.logger.info('V5_COMPLETE', { leadId, responseLength: response.length });
      return { command: 'SEND_MESSAGE', payload: { text: response } };
      
    } catch (error) {
      this.logger.error('V5_ERROR', { leadId, error: error.message });
      return { command: 'SEND_MESSAGE', payload: { text: 'Oi! Sou a Amanda da Fono Inova 💚 Me conta como posso te ajudar?' } };
    }
  }

  // Detecta usando detectores existentes do projeto
  detectar(text, lead) {
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    // TherapyDetector
    const therapies = detectAllTherapies(text);
    const therapy = therapies.length > 0 && !therapies[0].id.includes('fora_escopo')
      ? DETECTOR_MAP[therapies[0].id] || therapies[0].id
      : null;
    
    // FlagsDetector
    const flags = detectAllFlags(text, lead, { messageCount: 0 });
    
    // Extrai entidades
    const ageMatch = text.match(/(\d{1,2})\s*anos?/i);
    const age = ageMatch ? parseInt(ageMatch[1], 10) : null;
    
    let period = null;
    if (/manh[ãa]|cedo/i.test(lower)) period = 'manha';
    else if (/tarde/i.test(lower)) period = 'tarde';
    else if (/noite/i.test(lower)) period = 'noite';
    
    // Queixa (se não for pergunta direta)
    const isQuestion = /^(qual|quanto|onde|como|voce|voces|tem|faz|aceita)/i.test(text.trim());
    const complaint = !isQuestion && text.length > 10 
      ? text.replace(/^(oi|ola|bom dia|boa tarde)[,\s]*/i, '').substring(0, 200)
      : null;
    
    return { therapy, flags, age, period, complaint };
  }

  // FUNDE: acumula, nunca apaga (só sobrescreve se veio novo)
  fundir(old, detected) {
    return {
      therapy: detected.therapy || old.therapy || null,
      complaint: detected.complaint || old.complaint || null,
      age: detected.age || old.age || null,
      period: detected.period || old.period || null,
      flags: { ...old.flags, ...detected.flags }
    };
  }

  // LÓGICA ÚNICA de conversa fluida
  conversar(text, ctx) {
    const { therapy, complaint, age, period, flags } = ctx;
    
    // O que falta para agendar?
    const faltando = [];
    if (!therapy) faltando.push('therapy');
    if (therapy && !complaint) faltando.push('complaint');
    if (!age) faltando.push('age');
    if (!period) faltando.push('period');
    
    // ESTRATÉGIA 1: Responde interrupção E RETOMA
    if (flags.asksPrice && therapy) {
      return this.retomar(ctx, this.responderPreco(therapy));
    }
    if (flags.asksPrice && !therapy) {
      return this.retomar(ctx, 'Os valores variam conforme a especialidade 💚\n\nSessões: R$ 180 a R$ 300');
    }
    if (flags.asksAddress) {
      return this.retomar(ctx, '📍 Ficamos na Rua X, 123 - Centro de Anápolis. Estacionamento fácil!');
    }
    if (flags.asksPlans) {
      return this.retomar(ctx, '💚 Trabalhamos com reembolso de todos os planos! Você paga e solicita o ressarcimento (geralmente 80-100%).');
    }
    
    // ESTRATÉGIA 2: Tem tudo → agendamento
    if (faltando.length === 0) {
      return this.mostrarHorarios(therapy, age, period);
    }
    
    // ESTRATÉGIA 3: Pergunta o que falta (descoberta suave)
    return this.perguntarNatural(faltando[0], ctx);
  }

  // CRÍTICO: Sempre retoma o fluxo após responder interrupção
  retomar(ctx, respostaEspecifica) {
    const { therapy, complaint, age, period } = ctx;
    
    let pergunta = '';
    if (!therapy) {
      pergunta = '\n\nMe conta: você está buscando atendimento para fonoaudiologia, psicologia ou fisioterapia?';
    } else if (!complaint) {
      pergunta = `\n\nPara ${THERAPY_DATA[therapy]?.name || 'o atendimento'}, qual a situação que está enfrentando?`;
    } else if (!age) {
      pergunta = '\n\nE qual a idade? Isso ajuda a verificar os profissionais mais indicados 💚';
    } else if (!period) {
      pergunta = '\n\nQual período funciona melhor? Manhã, tarde ou noite?';
    } else {
      pergunta = '\n\nQuer que eu verifique a disponibilidade de horários?';
    }
    
    return respostaEspecifica + pergunta;
  }

  responderPreco(therapy) {
    const info = THERAPY_DATA[therapy];
    return `Para ${info.name} ${info.emoji}:\n${info.price}\n\nTrabalhamos com reembolso de planos também 💚`;
  }

  perguntarNatural(falta, ctx) {
    if (falta === 'therapy') {
      return 'Oi! Sou a Amanda da Fono Inova 💚\n\nMe conta: você está buscando atendimento para você ou para alguém da família? Qual situação vocês estão enfrentando?';
    }
    
    if (falta === 'complaint') {
      const { therapy } = ctx;
      if (therapy === 'fonoaudiologia') {
        return 'Entendi que é para fonoaudiologia 💬\n\nMe conta mais sobre a comunicação: ele fala algumas palavras, não fala ainda, ou tem alguma dificuldade específica?';
      }
      if (therapy === 'psicologia') {
        return 'Sobre psicologia 🧠\n\nMe conta como vocês estão se sentindo - é ansiedade, dificuldade para dormir, ou algo mais? Estou aqui para ouvir 💚';
      }
      return `Para ${THERAPY_DATA[therapy]?.name || 'o atendimento'} 💚\n\nMe conta um pouco sobre a situação que está preocupando?`;
    }
    
    if (falta === 'age') {
      return ctx.therapy === 'fonoaudiologia'
        ? 'E qual a idade da criança? Isso ajuda a verificar os profissionais mais indicados para essa fase 💚'
        : 'Qual a idade? Isso ajuda a verificar a disponibilidade dos melhores profissionais 💚';
    }
    
    if (falta === 'period') {
      return 'Qual período funciona melhor para vocês? Manhã, tarde ou noite?';
    }
    
    return 'Como posso te ajudar? 💚';
  }

  async mostrarHorarios(therapy, age, period) {
    try {
      const slots = await findAvailableSlots({ therapyArea: therapy, preferredPeriod: period, patientAge: age });
      const info = THERAPY_DATA[therapy];
      
      if (slots?.primary?.length > 0) {
        const txt = slots.primary.slice(0, 3).map(s => `• ${s.day} às ${s.time}`).join('\n');
        return `Encontrei essas opções para ${info?.name || therapy}:\n\n${txt}\n\nQual funciona melhor? 💚`;
      }
      return `No momento não encontrei vagas para ${info?.name || therapy} no período da ${period}.\n\nPosso pedir para nossa equipe entrar em contato?`;
    } catch (e) {
      return 'Vou verificar os horários e te retorno! 💚';
    }
  }

  async loadMemory(leadId) {
    try {
      const ctx = await ChatContext.findOne({ lead: leadId }).lean();
      return ctx?.conversationState || { therapy: null, complaint: null, age: null, period: null, flags: {} };
    } catch (e) {
      return { therapy: null, complaint: null, age: null, period: null, flags: {} };
    }
  }

  async saveMemory(leadId, context) {
    try {
      await ChatContext.findOneAndUpdate(
        { lead: leadId },
        { $set: { conversationState: context, lastContactAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      this.logger.error('V5_SAVE_ERROR', { leadId: leadId?.toString(), error: e.message });
    }
  }
}

export default WhatsAppOrchestrator;
