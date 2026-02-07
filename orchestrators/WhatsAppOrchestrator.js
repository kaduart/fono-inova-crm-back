import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import { detectAllTherapies } from '../utils/therapyDetector.js';
import { detectAllFlags } from '../utils/flagsDetector.js';

// Dados das terapias
const THERAPY_INFO = {
  fonoaudiologia: { name: 'Fonoaudiologia', emoji: '💬', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  psicologia: { name: 'Psicologia', emoji: '🧠', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  fisioterapia: { name: 'Fisioterapia', emoji: '🏃', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  terapia_ocupacional: { name: 'Terapia Ocupacional', emoji: '🤲', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  psicopedagogia: { name: 'Psicopedagogia', emoji: '📚', price: 'Sessão: R$ 200 | Pacote 4x: R$ 180 cada' },
  neuropsicologia: { name: 'Neuropsicologia', emoji: '🧩', price: 'Avaliação: R$ 400 | Retorno: R$ 250' },
  musicoterapia: { name: 'Musicoterapia', emoji: '🎵', price: 'Sessão: R$ 180 | Pacote 4x: R$ 160 cada' },
  psicomotricidade: { name: 'Psicomotricidade', emoji: '🤸', price: 'Sessão: R$ 180 | Pacote 4x: R$ 160 cada' },
  pediatria: { name: 'Pediatria', emoji: '👶', price: 'Consulta: R$ 250 | Retorno: R$ 180' },
  neuroped: { name: 'Neuropediatria', emoji: '🧠', price: 'Consulta: R$ 300 | Retorno: R$ 200' }
};

// Mapeamento therapyDetector
const DETECTOR_MAP = {
  'speech': 'fonoaudiologia',
  'tongue_tie': 'fonoaudiologia',
  'psychology': 'psicologia',
  'physiotherapy': 'fisioterapia',
  'occupational': 'terapia_ocupacional',
  'psychopedagogy': 'psicopedagogia',
  'neuropsychological': 'neuropsicologia',
  'music': 'musicoterapia',
  'neuropsychopedagogy': 'psicopedagogia'
};

// Marcadores emocionais para acolhimento
const EMOTIONAL_MARKERS = {
  ansiedade: ['ansioso', 'ansiosa', 'nervoso', 'preocupado', 'medo', 'pânico', 'angústia'],
  tristeza: ['triste', 'choro', 'chorando', 'depressão', 'deprimido', 'sem ânimo'],
  desespero: ['desesperado', 'não aguento', 'me ajuda', 'urgente', 'preciso de ajuda'],
  frustração: ['cansado', 'frustrado', 'tentei tudo', 'nada funciona', 'desisti']
};

export class WhatsAppOrchestrator {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestrator');
  }

  async process({ lead, message }) {
    const startTime = Date.now();
    const leadId = lead?._id?.toString() || 'unknown';
    const text = message?.content || message?.text || '';
    
    this.logger.info('V5_START', { leadId, text: text.substring(0, 80) });

    try {
      // 1. Carrega contexto acumulado
      const context = await this.loadContext(lead);
      
      // 2. Análise completa usando detectores do projeto
      const analysis = await this.analyzeComplete(text, lead, context);
      this.logger.info('V5_ANALYSIS', { 
        leadId, 
        therapy: analysis.therapy,
        flags: Object.keys(analysis.flags).filter(k => analysis.flags[k]),
        emotionalState: analysis.emotionalState,
        confidence: analysis.confidence
      });

      // 3. Acumula contexto (soma, não substitui)
      const newContext = this.accumulateContext(context, analysis);
      
      // 4. Decisão estratégica baseada no contexto completo
      const response = await this.strategicResponse(text, newContext, analysis);
      
      // 5. Persiste
      await this.saveContext(lead._id, newContext);
      
      this.logger.info('V5_COMPLETE', { leadId, timeMs: Date.now() - startTime });
      return { command: 'SEND_MESSAGE', payload: { text: response } };
      
    } catch (error) {
      this.logger.error('V5_ERROR', { leadId, error: error.message });
      return { command: 'SEND_MESSAGE', payload: { text: 'Oi! Sou a Amanda da Fono Inova 💚 Me conta como posso te ajudar?' } };
    }
  }

  // Análise completa usando TODOS os detectores
  async analyzeComplete(text, lead, context) {
    const result = {
      therapy: null,
      flags: {},
      entities: { age: null, period: null, complaint: null },
      emotionalState: null,
      confidence: 0,
      intent: 'general'
    };

    // 1. THERAPY DETECTOR (robusto)
    const therapies = detectAllTherapies(text);
    if (therapies.length > 0 && !therapies[0].id.includes('fora_escopo')) {
      result.therapy = DETECTOR_MAP[therapies[0].id] || therapies[0].id;
      result.confidence += 0.4;
    }

    // 2. FLAGS DETECTOR (completo)
    result.flags = detectAllFlags(text, lead, {
      stage: context.therapy ? 'engaged' : 'new',
      messageCount: context.history?.length || 0,
      conversationHistory: context.history || []
    });

    // Detecta intenção pelos flags
    if (result.flags.asksPrice) result.intent = 'price';
    else if (result.flags.asksAddress) result.intent = 'address';
    else if (result.flags.asksPlans) result.intent = 'plans';
    else if (result.flags.wantsSchedule) result.intent = 'schedule';

    // 3. Extração de entidades
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    // Idade
    const ageMatch = text.match(/(\d{1,2})\s*anos?/i) || text.match(/tem\s*(\d{1,2})/i);
    if (ageMatch) {
      result.entities.age = parseInt(ageMatch[1], 10);
      result.confidence += 0.2;
    }
    
    // Período
    if (/manh[ãa]|cedo|in[ií]cio/i.test(lower)) result.entities.period = 'manha';
    else if (/tarde/i.test(lower)) result.entities.period = 'tarde';
    else if (/noite/i.test(lower)) result.entities.period = 'noite';
    
    // Queixa (texto descritivo)
    const isQuestion = /^(qual|quanto|onde|como|voce|voces|tem|faz|aceita)/i.test(text.trim());
    if (!isQuestion && text.length > 10 && text.length < 300) {
      result.entities.complaint = text.replace(/^(oi|ola|bom dia|boa tarde)[,\s]*/i, '').trim();
    }

    // 4. Análise emocional
    result.emotionalState = this.detectEmotionalState(lower);

    // 5. LLM para enriquecer (se necessário)
    if (result.confidence < 0.5) {
      try {
        const llm = await analyzeLeadMessage({ text, history: context.history?.slice(-3) || [] });
        if (llm?.extractedInfo) {
          if (!result.therapy && llm.extractedInfo.especialidade) {
            result.therapy = this.normalizeTherapy(llm.extractedInfo.especialidade);
          }
          if (!result.entities.complaint && llm.extractedInfo.queixa) {
            result.entities.complaint = llm.extractedInfo.queixa;
          }
          if (!result.entities.age && llm.extractedInfo.idade) {
            result.entities.age = parseInt(llm.extractedInfo.idade, 10);
          }
        }
      } catch (e) {
        // ignora
      }
    }

    return result;
  }

  detectEmotionalState(text) {
    for (const [state, keywords] of Object.entries(EMOTIONAL_MARKERS)) {
      if (keywords.some(k => text.includes(k))) return state;
    }
    return null;
  }

  accumulateContext(context, analysis) {
    return {
      therapy: analysis.therapy || context.therapy || null,
      complaint: analysis.entities.complaint || context.complaint || null,
      age: analysis.entities.age || context.age || null,
      period: analysis.entities.period || context.period || null,
      emotionalState: analysis.emotionalState || context.emotionalState || null,
      flags: { ...context.flags, ...analysis.flags },
      history: [...(context.history || []), { text: analysis.entities.complaint, timestamp: new Date() }].slice(-10)
    };
  }

  // Resposta estratégica com acolhimento psicológico
  async strategicResponse(text, context, analysis) {
    const { therapy, complaint, age, period, flags, emotionalState } = context;
    
    // O que falta para agendar?
    const missing = [];
    if (!therapy) missing.push('therapy');
    if (therapy && !complaint) missing.push('complaint');
    if (!age) missing.push('age');
    if (!period) missing.push('period');

    // ESTRATÉGIA 1: Acolhimento emocional primeiro (se necessário)
    if (emotionalState && !context.acolhimentoFeito) {
      context.acolhimentoFeito = true;
      return this.acolhimentoEmocional(emotionalState, therapy, missing);
    }

    // ESTRATÉGIA 2: Responder flags imediatos (mas manter contexto!)
    if (flags.asksPrice && therapy) {
      return this.respostaPrecoComContexto(therapy, missing);
    }
    if (flags.asksPrice && !therapy) {
      return this.respostaPrecoSemContexto();
    }
    if (flags.asksAddress) {
      return this.respostaEnderecoComContexto(therapy, missing);
    }
    if (flags.asksPlans) {
      return this.respostaPlanoComContexto(therapy, missing);
    }

    // ESTRATÉGIA 3: Se tem tudo, mostra slots
    if (missing.length === 0) {
      return await this.mostrarSlots(therapy, period, age);
    }

    // ESTRATÉGIA 4: Pergunta o que falta com contexto
    return this.perguntaContextual(missing[0], context);
  }

  acolhimentoEmocional(estado, therapy, missing) {
    const acolhimentos = {
      ansiedade: `Entendo que vocês estão passando por um momento de ansiedade 💚 Isso é mais comum do que parece, e tratado cedo tem resultados excelentes.`,
      tristeza: `Sinto que vocês estão enfrentando um momento difícil 💚 Estamos aqui para apoiar com muito carinho.`,
      desespero: `Percebo que vocês precisam de ajuda urgente 💚 Vamos encontrar a melhor solução juntos.`,
      frustração: `Entendo que já tentaram várias coisas 💚 Às vezes a abordagem certa faz toda a diferença.`
    };
    
    let response = acolhimentos[estado] || `Estou aqui para ajudar 💚`;
    
    if (!therapy) response += `\n\nPara qual especialidade vocês precisam?`;
    else if (missing.includes('complaint')) response += `\n\nMe conta um pouco sobre a situação para eu entender melhor.`;
    else if (missing.includes('age')) response += `\n\nQual a idade?`;
    else if (missing.includes('period')) response += `\n\nQual período funciona melhor?`;
    
    return response;
  }

  respostaPrecoComContexto(therapy, missing) {
    const info = THERAPY_INFO[therapy];
    let response = `Para ${info.name} ${info.emoji}:\n${info.price}\n\nTrabalhamos com reembolso de planos também 💚`;
    
    if (missing.includes('complaint')) response += `\n\nQual a situação específica?`;
    else if (missing.includes('age')) response += `\n\nQual a idade?`;
    else if (missing.includes('period')) response += `\n\nQual período?`;
    else response += `\n\nPosso verificar os horários!`;
    
    return response;
  }

  respostaPrecoSemContexto() {
    return `Os valores variam conforme a especialidade 💚\n\n• Sessões: R$ 180 a R$ 300\n• Pacotes: desconto de 10-20%\n\nMe conta qual situação vocês estão enfrentando que aí consigo te passar o valor exato!`;
  }

  respostaEnderecoComContexto(therapy, missing) {
    let response = `📍 Ficamos na Rua X, 123 - Centro de Anápolis. Estacionamento fácil!`;
    if (therapy && missing.length > 0) {
      response += `\n\nPara continuarmos com ${THERAPY_INFO[therapy].name.toLowerCase()}, `;
      if (missing.includes('complaint')) response += `qual a situação?`;
      else if (missing.includes('age')) response += `qual a idade?`;
      else if (missing.includes('period')) response += `qual período?`;
    } else if (!therapy) {
      response += `\n\nQual especialidade você precisa?`;
    }
    return response;
  }

  respostaPlanoComContexto(therapy, missing) {
    let response = `💚 Trabalhamos com reembolso de todos os planos. Você paga e solicita o ressarcimento (geralmente 80-100%).`;
    if (therapy && missing.includes('complaint')) {
      response += `\n\nPara ${THERAPY_INFO[therapy].name}, qual a situação?`;
    } else if (!therapy) {
      response += `\n\nQual especialidade?`;
    }
    return response;
  }

  async mostrarSlots(therapy, period, age) {
    try {
      const slots = await findAvailableSlots({ therapyArea: therapy, preferredPeriod: period, patientAge: age });
      const info = THERAPY_INFO[therapy];
      
      if (slots?.primary?.length > 0) {
        const txt = slots.primary.slice(0, 3).map(s => `• ${s.day} às ${s.time}`).join('\n');
        return `Encontrei para ${info.name}:\n\n${txt}\n\nQual funciona melhor? 💚`;
      }
      return `No momento não encontrei vagas para ${info.name} no período da ${period}.\n\nPosso pedir para nossa equipe entrar em contato?`;
    } catch (e) {
      return `Vou verificar os horários e te retorno! 💚`;
    }
  }

  perguntaContextual(field, context) {
    const { therapy, complaint, age, emotionalState } = context;
    
    const templates = {
      therapy: emotionalState 
        ? `Para podermos ajudar da melhor forma 💚, qual especialidade vocês procuram? Fonoaudiologia, psicologia ou fisioterapia?`
        : `Oi! Sou a Amanda da Fono Inova 💚\n\nMe conta: você está buscando atendimento para fonoaudiologia, psicologia ou fisioterapia?`,
        
      complaint: therapy === 'fonoaudiologia' 
        ? `Para fonoaudiologia 💬, me conta mais: é sobre atraso na fala, gagueira, autismo, troca de letras, ou outra situação?`
        : therapy === 'psicologia'
        ? `Para psicologia 🧠, me conta como vocês estão se sentindo - é ansiedade, dificuldade para dormir, mudanças de humor, TDAH, ou algo mais?`
        : therapy === 'fisioterapia'
        ? `Para fisioterapia 🏃, onde está sentindo dor ou desconforto?`
        : `Para ${THERAPY_INFO[therapy]?.name || 'o atendimento'}, qual a situação que está preocupando?`,
        
      age: therapy === 'fonoaudiologia'
        ? `Qual a idade da criança? Isso ajuda a verificar os profissionais mais experientes com essa faixa etária 💚`
        : `Qual a idade? Isso ajuda a verificar a disponibilidade dos melhores profissionais 💚`,
        
      period: `Qual período funciona melhor para vocês? Manhã, tarde ou noite?`
    };
    
    return templates[field] || `Como posso te ajudar? 💚`;
  }

  async loadContext(lead) {
    try {
      const doc = await Leads.findById(lead._id).lean();
      return doc?.v5Context || {
        therapy: doc?.therapyArea || null,
        complaint: doc?.primaryComplaint || null,
        age: doc?.patientInfo?.age || null,
        period: doc?.pendingPreferredPeriod || null,
        flags: {},
        emotionalState: null,
        acolhimentoFeito: false,
        history: []
      };
    } catch (e) {
      return { therapy: null, complaint: null, age: null, period: null, flags: {}, emotionalState: null, acolhimentoFeito: false, history: [] };
    }
  }

  async saveContext(leadId, context) {
    try {
      await Leads.findByIdAndUpdate(leadId, {
        $set: {
          v5Context: context,
          therapyArea: context.therapy,
          primaryComplaint: context.complaint,
          'patientInfo.age': context.age,
          pendingPreferredPeriod: context.period
        }
      });
    } catch (e) {
      this.logger.error('V5_SAVE_ERROR', { leadId: leadId?.toString(), error: e.message });
    }
  }

  normalizeTherapy(t) {
    if (!t) return null;
    const normalized = t.toLowerCase().trim();
    const map = {
      'fonoaudiologia': 'fonoaudiologia', 'fono': 'fonoaudiologia',
      'psicologia': 'psicologia', 'psico': 'psicologia',
      'fisioterapia': 'fisioterapia', 'fisio': 'fisioterapia'
    };
    return map[normalized] || normalized;
  }
}

export default WhatsAppOrchestrator;
