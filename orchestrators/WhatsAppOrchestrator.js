// orchestrators/WhatsAppOrchestrator.js
// FSM Determinística + Context Stack + Handlers preservados do V7
// IA = APENAS NLU (interpretar texto). Caminho = 100% determinístico.

import { PRICES, formatPrice, getTherapyPricing } from '../config/pricing.js';
import BookingHandler from '../handlers/BookingHandler.js';
import { leadRepository } from '../infrastructure/persistence/LeadRepository.js';
import Leads from '../models/Leads.js';
import { perceptionService } from '../perception/PerceptionService.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import { getLatestInsights } from '../services/amandaLearningService.js';
import {
  STATES,
  advanceState,
  jumpToState,
  detectGlobalIntent,
  suspendState,
  resumeState,
  incrementRetry,
  getResumeHint,
  isAutoResume,
} from '../services/StateMachine.js';
import Logger from '../services/utils/Logger.js';
import { buildDecisionContext } from '../adapters/BookingContextAdapter.js';
import { THERAPY_DATA, detectAllTherapies } from '../utils/therapyDetector.js';
import { extractName, extractBirth, extractAgeFromText, extractPeriodFromText } from '../utils/patientDataExtractor.js';

const logger = new Logger('WhatsAppOrchestrator');

export default class WhatsAppOrchestrator {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestrator');
    this.insightsCache = null;
    this.cacheTime = 0;
  }

  // ═══════════════════════════════════════════
  // PONTO DE ENTRADA PRINCIPAL
  // ═══════════════════════════════════════════

  async process({ lead, message, context: providedContext = null, services = {} }) {
    try {
      const leadId = lead?._id;
      const text = (message?.content || message?.text || '').trim();

      if (!leadId) {
        this.logger.warn('PROCESS_MISSING_LEAD_ID', { from: message?.from });
        return { command: 'NO_REPLY' };
      }

      // ══ CIRCUIT BREAKERS (antes de tudo) ══
      if (this._isHardStopMessage(text)) {
        return { command: 'NO_REPLY' };
      }

      if (this._isCancellation(text)) {
        await this._clearState(leadId);
        return this._reply('Entendido! Cancelado aqui pra você 😊');
      }

      // ══ CARREGA ESTADO ATUAL DO LEAD (fonte única de verdade) ══
      const freshLead = await Leads.findById(leadId).lean();
      if (!freshLead) return { command: 'NO_REPLY' };

      const currentState = freshLead.currentState || STATES.IDLE;
      const stateData = freshLead.stateData || {};

      this.logger.info('V8_PROCESS', { leadId, currentState, text: text.substring(0, 50) });

      // ══ 1. DETECÇÃO DE INTERRUPÇÃO GLOBAL ══
      // Se está no meio de um fluxo e o lead pergunta preço/local/plano
      const globalIntent = detectGlobalIntent(text);
      const isInFlow = ![STATES.IDLE, STATES.GREETING, STATES.BOOKED, STATES.HANDOFF].includes(currentState);

      if (globalIntent && isInFlow && currentState !== STATES.INTERRUPTED) {
        // Empilha estado atual e responde a dúvida
        await suspendState(leadId, currentState, stateData, globalIntent);
        const interruptResponse = this._handleGlobalIntent(globalIntent, freshLead);
        const resumeHint = getResumeHint(currentState);
        return this._reply(`${interruptResponse}\n\n${resumeHint}`);
      }

      // ══ 2. RETOMADA PÓS-INTERRUPÇÃO ══
      if (currentState === STATES.INTERRUPTED) {
        const stack = freshLead.stateStack || [];
        const lastSuspended = stack.length > 0 ? stack[stack.length - 1] : null;

        if (lastSuspended) {
          // Verifica se o lead perguntou OUTRA coisa lateral (interrupção em cima de interrupção)
          const anotherGlobal = detectGlobalIntent(text);
          if (anotherGlobal) {
            const interruptResponse = this._handleGlobalIntent(anotherGlobal, freshLead);
            const resumeHint = getResumeHint(lastSuspended.state);
            return this._reply(`${interruptResponse}\n\n${resumeHint}`);
          }

          // Tenta retomada automática (ex: mandou um nome quando estava em COLLECT_NAME)
          if (isAutoResume(text, lastSuspended.state)) {
            const resumed = await resumeState(leadId);
            if (resumed) {
              // Processa a mensagem no estado restaurado
              return this._processState(resumed.state, text, resumed.lead, resumed.data, services);
            }
          }

          // Se não é intent lateral nem resposta direta, tenta retomar mesmo assim
          // (provavelmente o lead respondeu "ok" ou "entendi")
          if (/^(ok|entendi|sim|voltando|e sobre|agendamento|horário|beleza|tá|ta)/i.test(text.trim())) {
            const resumed = await resumeState(leadId);
            if (resumed) {
              const hint = getResumeHint(resumed.state);
              return this._reply(hint);
            }
          }

          // Fallback: repete o gancho de retomada
          const hint = getResumeHint(lastSuspended.state);
          return this._reply(`Pra tirar qualquer dúvida, tô aqui! 💚\n\n${hint}`);
        }

        // Stack vazia = volta pro IDLE
        await jumpToState(leadId, STATES.IDLE);
        return this._processState(STATES.IDLE, text, freshLead, {}, services);
      }

      // ══ 3. FSM DETERMINÍSTICA ══
      return this._processState(currentState, text, freshLead, stateData, services);

    } catch (error) {
      this.logger.error('V8_CRITICAL_ERROR', { error: error.message, stack: error.stack });
      return this._reply('Ops, deu um probleminha técnico aqui! 😅 Pode repetir sua mensagem?');
    }
  }

  // ═══════════════════════════════════════════
  // FSM: SWITCH DETERMINÍSTICO
  // ═══════════════════════════════════════════

  async _processState(state, text, lead, stateData, services = {}) {
    const leadId = lead._id;

    switch (state) {
      // ── ESTADO INICIAL ──
      case STATES.IDLE:
      case STATES.GREETING: {
        // Tenta extrair tudo que puder da primeira mensagem
        const facts = await this._analyze(text, lead);
        const therapies = facts?.therapies || detectAllTherapies(text);
        const therapy = therapies.length > 0 ? therapies[0] : null;

        if (therapy) {
          // Já disse a terapia na saudação → pula COLLECT_THERAPY
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { therapy });
          await this._saveTherapy(leadId, therapy);
          return this._reply(`Que bom que entrou em contato! 😊\n\nSobre ${THERAPY_DATA[therapy]?.name || therapy} ${THERAPY_DATA[therapy]?.emoji || '💚'}...\n\nMe conta um pouco da situação? O que tá preocupando?`);
        }

        await jumpToState(leadId, STATES.COLLECT_THERAPY);
        return this._reply('Oi! Sou a Amanda da Fono Inova! 😊\n\nQue bom que você entrou em contato!\n\nMe conta: tá procurando fono, psico, fisio, ou qual especialidade?');
      }

      // ── COLETA DE TERAPIA ──
      case STATES.COLLECT_THERAPY: {
        const therapies = detectAllTherapies(text);
        if (therapies.length > 0) {
          const therapy = therapies[0];
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { therapy });
          await this._saveTherapy(leadId, therapy);
          return this._reply(`${THERAPY_DATA[therapy]?.name || therapy} ${THERAPY_DATA[therapy]?.emoji || '💚'}, ótima escolha!\n\nMe conta um pouco da situação que tá preocupando?`);
        }

        // Não entendeu a terapia → retry
        const { handoff } = await incrementRetry(leadId);
        if (handoff) return this._handoffReply();
        return this._reply('Hmm, não consegui identificar a especialidade 🤔\n\nTrabalhamos com Fono, Psico, Fisioterapia, Psicopedagogia, Musicoterapia e Neuropsico.\n\nQual dessas você procura?');
      }

      // ── COLETA DE QUEIXA ──
      case STATES.COLLECT_COMPLAINT: {
        // Qualquer texto > 5 chars é aceito como queixa
        if (text.length > 5) {
          const complaint = text.substring(0, 200);
          const newData = { ...stateData, complaint };

          // Tenta extrair idade desta mensagem
          const age = extractAgeFromText(text);
          if (age) {
            newData.age = age;
            // Pula COLLECT_BIRTH → vai direto pra COLLECT_PERIOD
            await jumpToState(leadId, STATES.COLLECT_PERIOD, newData);
            await this._saveComplaintAndAge(leadId, complaint, age);
            return this._reply(`Entendi! ${age} anos${stateData.therapy ? `, pra ${THERAPY_DATA[stateData.therapy]?.name || stateData.therapy}` : ''}.\n\nQue período funciona melhor: **manhã ou tarde**? ☀️🌙`);
          }

          await jumpToState(leadId, STATES.COLLECT_BIRTH, newData);
          await this._saveComplaint(leadId, complaint);
          return this._reply(`Entendi a situação! 💚\n\nE qual a idade do paciente?`);
        }

        const { handoff } = await incrementRetry(leadId);
        if (handoff) return this._handoffReply();
        return this._reply('Me conta um pouco mais sobre a situação? 😊');
      }

      // ── COLETA DE IDADE/NASCIMENTO ──
      case STATES.COLLECT_BIRTH: {
        const age = extractAgeFromText(text);
        const birth = extractBirth(text);

        if (age || birth) {
          const newData = { ...stateData, age: age || null, birthDate: birth || null };
          await jumpToState(leadId, STATES.COLLECT_PERIOD, newData);
          await this._saveAge(leadId, age, birth);
          return this._reply(`${age ? `${age} anos` : 'Anotado'}, perfeito! 📝\n\nQue período funciona melhor: **manhã ou tarde**? ☀️🌙`);
        }

        const { handoff } = await incrementRetry(leadId);
        if (handoff) return this._handoffReply();
        return this._reply('Preciso só da idade ou data de nascimento pra buscar os horários certinhos 💚');
      }

      // ── COLETA DE PERÍODO ──
      case STATES.COLLECT_PERIOD: {
        const period = extractPeriodFromText(text);
        if (period) {
          const newData = { ...stateData, period };
          await jumpToState(leadId, STATES.SHOW_SLOTS, newData);
          await this._savePeriod(leadId, period);
          // Busca slots e mostra
          return this._handleOfferBooking(newData, lead, services);
        }

        const { handoff } = await incrementRetry(leadId);
        if (handoff) return this._handoffReply();
        return this._reply('Prefere **manhã** ou **tarde**? (Nosso horário: 8h às 18h) ☀️🌙');
      }

      // ── MOSTRANDO SLOTS ──
      case STATES.SHOW_SLOTS: {
        // Lead escolheu uma opção (A, B, C...)
        const choice = text.trim().charAt(0).toUpperCase();
        if (/^[A-F]$/.test(choice)) {
          const newData = { ...stateData, chosenSlot: choice };
          await jumpToState(leadId, STATES.COLLECT_PATIENT_DATA, newData);
          return this._reply(`Ótima escolha! Opção ${choice} 💚\n\nPra confirmar o agendamento, preciso do nome completo do paciente:`);
        }

        const { handoff } = await incrementRetry(leadId);
        if (handoff) return this._handoffReply();
        return this._reply('Pra continuar, é só escolher uma das opções (A, B, C...) 💚');
      }

      // ── COLETA DE DADOS DO PACIENTE ──
      case STATES.COLLECT_PATIENT_DATA: {
        const name = extractName(text);
        if (name && name.length >= 3) {
          const newData = { ...stateData, patientName: name };
          await jumpToState(leadId, STATES.CONFIRM_BOOKING, newData);
          await this._savePatientName(leadId, name);
          return this._reply(`Paciente: **${name}**\nHorário: Opção ${stateData.chosenSlot}\n\nPosso confirmar? (Sim/Não) ✅`);
        }

        const { handoff } = await incrementRetry(leadId);
        if (handoff) return this._handoffReply();
        return this._reply('Preciso do nome completo do paciente pra confirmar 💚');
      }

      // ── CONFIRMAÇÃO ──
      case STATES.CONFIRM_BOOKING: {
        const isYes = /^(sim|confirma|pode|bora|isso|ok|yes|claro)/i.test(text.trim());
        if (isYes) {
          await jumpToState(leadId, STATES.BOOKED, stateData);
          return this._reply(`✅ Agendamento confirmado!\n\n📋 Paciente: ${stateData.patientName}\n🕐 Horário: Opção ${stateData.chosenSlot}\n\nVou enviar a confirmação com todos os detalhes! Até lá 💚`);
        }

        const isNo = /^(não|nao|cancela|desist)/i.test(text.trim());
        if (isNo) {
          await this._clearState(leadId);
          return this._reply('Sem problema! Se mudar de ideia, é só chamar 💚');
        }

        return this._reply('Posso confirmar esse agendamento? Só dizer **Sim** ou **Não** 😊');
      }

      // ── AGENDADO ──
      case STATES.BOOKED: {
        return this._reply('Seu agendamento já foi confirmado! 💚\n\nSe precisar de algo mais, tô aqui! 😊');
      }

      // ── HANDOFF HUMANO ──
      case STATES.HANDOFF: {
        return this._reply('Vou te transferir para nossa equipe que vai te ajudar pessoalmente! 💚 Aguarda só um minutinho...');
      }

      default: {
        this.logger.warn('V8_UNKNOWN_STATE', { state });
        await jumpToState(leadId, STATES.IDLE);
        return this._processState(STATES.IDLE, text, lead, {}, services);
      }
    }
  }

  // ═══════════════════════════════════════════
  // HANDLERS DE INTERRUPÇÃO GLOBAL
  // ═══════════════════════════════════════════

  _handleGlobalIntent(intentType, lead) {
    switch (intentType) {
      case 'PRICE_QUERY':
        return this._handlePriceInquiry(lead);

      case 'LOCATION_QUERY':
        return '📍 Ficamos na Av. Brasil, 1234 - Centro de Anápolis/GO.\n\nTem estacionamento fácil na rua! 🚗';

      case 'INSURANCE_QUERY':
        return 'Trabalhamos com reembolso de todos os planos! Você paga e solicita o ressarcimento (geralmente 80-100%).\n\nTambém aceitamos Pix, cartão de crédito e débito! 😊';

      case 'CONTACT_QUERY':
        return '📞 Nosso WhatsApp é esse mesmo! Pode mandar mensagem a qualquer hora 😊';

      case 'HOURS_QUERY':
        return '🕐 Funcionamos de Segunda a Sexta, das 8h às 18h!\n\nSábados com agendamento prévio 😊';

      default:
        return 'Claro, posso ajudar com isso! 💚';
    }
  }

  _handlePriceInquiry(lead) {
    const therapy = lead.therapyArea || lead.stateData?.therapy;
    const info = therapy ? THERAPY_DATA[therapy] : null;

    if (info) {
      const pricing = getTherapyPricing(therapy) || { avaliacao: 200 };
      const valor = formatPrice(pricing.avaliacao);
      return `Pra ${info.name} ${info.emoji}:\n\n💰 Avaliação: ${valor}\n\nÉ ${info.investimento || 'investimento acessível'} (${info.duracao || '50min'}).\n\nE o melhor: trabalhamos com reembolso de plano! 💚`;
    }

    return `Nossos valores:\n\n💬 Fonoaudiologia: ${PRICES.avaliacaoInicial}\n🧠 Psicologia: ${PRICES.avaliacaoInicial}\n🏃 Fisioterapia: ${PRICES.avaliacaoInicial}\n📚 Psicopedagogia: ${PRICES.avaliacaoInicial}\n🎵 Musicoterapia: ${PRICES.sessaoAvulsa}\n🧩 Neuropsicologia: ${PRICES.neuropsicologica}\n\nTrabalhamos com reembolso de plano! 💚`;
  }

  // ═══════════════════════════════════════════
  // BUSCA E OFERTA DE SLOTS
  // ═══════════════════════════════════════════

  async _handleOfferBooking(stateData, lead, services) {
    try {
      const slots = await Promise.race([
        findAvailableSlots({
          therapyArea: stateData.therapy,
          preferredPeriod: stateData.period,
          patientAge: stateData.age,
          maxDoctors: 2,
          maxDays: 3,
          timeoutMs: 5000,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SLOT_SEARCH_TIMEOUT')), 5000)
        )
      ]);

      if (slots?.primary?.length > 0) {
        await leadRepository.persistSchedulingSlots(lead._id, slots);
        const decisionContext = buildDecisionContext({
          lead,
          message: '',
          context: stateData,
          slots,
        });
        const bookingResponse = await BookingHandler.execute({ decisionContext, services: {} });
        return this._reply(bookingResponse.text);
      }

      return this._reply(`Hmm, não encontrei horários para ${stateData.period || 'esse período'} agora 😕\n\nQuer que eu busque em outro período? (manhã/tarde)`);

    } catch (error) {
      this.logger.error('V8_SLOT_SEARCH_ERROR', { error: error.message });
      return this._reply(`Estou verificando a agenda... Pode ser que eu precise de mais um instante! 💚\n\nEnquanto isso, prefere atendimento presencial ou online?`);
    }
  }

  // ═══════════════════════════════════════════
  // PERSISTÊNCIA ATÔMICA
  // ═══════════════════════════════════════════

  async _saveTherapy(leadId, therapy) {
    // 🔧 Normaliza therapy para string (pode vir como objeto de detectAllTherapies)
    let therapyString = therapy;
    if (typeof therapy === 'object' && therapy?.id) {
      const areaMap = {
        "neuropsychological": "neuropsicologia",
        "speech": "fonoaudiologia",
        "tongue_tie": "fonoaudiologia",
        "psychology": "psicologia",
        "occupational": "terapia_ocupacional",
        "physiotherapy": "fisioterapia",
        "music": "musicoterapia",
        "neuropsychopedagogy": "neuropsicologia",
        "psychopedagogy": "neuropsicologia",
      };
      therapyString = areaMap[therapy.id] || therapy.name || therapy;
    }
    await Leads.updateOne({ _id: leadId }, { $set: { therapyArea: therapyString } });
  }

  async _saveComplaint(leadId, complaint) {
    await Leads.updateOne({ _id: leadId }, { $set: { 'autoBookingContext.complaint': complaint } });
  }

  async _saveComplaintAndAge(leadId, complaint, age) {
    await Leads.updateOne({ _id: leadId }, {
      $set: {
        'autoBookingContext.complaint': complaint,
        'patientInfo.age': age,
      }
    });
  }

  async _saveAge(leadId, age, birth) {
    const update = {};
    if (age) update['patientInfo.age'] = age;
    if (birth) update['patientInfo.birthDate'] = birth;
    await Leads.updateOne({ _id: leadId }, { $set: update });
  }

  async _savePeriod(leadId, period) {
    await Leads.updateOne({ _id: leadId }, { $set: { 'autoBookingContext.preferredPeriod': period } });
  }

  async _savePatientName(leadId, name) {
    await Leads.updateOne({ _id: leadId }, { $set: { 'patientInfo.fullName': name } });
  }

  async _clearState(leadId) {
    await Leads.updateOne({ _id: leadId }, {
      $set: {
        currentState: STATES.IDLE,
        stateData: {},
        stateStack: [],
        retryCount: 0,
        pendingSchedulingSlots: null,
        pendingChosenSlot: null,
        pendingPatientInfoStep: null,
      }
    });
  }

  // ═══════════════════════════════════════════
  // CIRCUIT BREAKERS (preservados do V7)
  // ═══════════════════════════════════════════

  _isHardStopMessage(text = '') {
    const lower = text.toLowerCase().trim();
    const isClosingStart = /^(obg|obrigad[oa]|valeu|tchau|at[ée] logo|boa (tarde|noite|dia))(\s|!|☺️|🙏|👍|$)/i.test(lower);
    if (isClosingStart) {
      const hasQuestion = /\b(quero|qual|como|onde|quando|vou agendar|marca)\b/i.test(lower);
      if (!hasQuestion) return true;
    }
    return /^[\u{1F44D}\u{1F64F}\u{263A}\u{2764}\u{1F49A}\u{2705}]+$/u.test(lower);
  }

  _isCancellation(text = '') {
    return /^(cancela|cancelar|desist|não quero mais|não vou agendar)/i.test(text.toLowerCase());
  }

  // ═══════════════════════════════════════════
  // NLU HELPER
  // ═══════════════════════════════════════════

  async _analyze(text, lead) {
    try {
      return await perceptionService.analyze(text, lead, {});
    } catch (e) {
      this.logger.warn('PERCEPTION_ERROR', { error: e.message });
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // UTIL
  // ═══════════════════════════════════════════

  _reply(text) {
    return { command: 'SEND_MESSAGE', payload: { text } };
  }

  _handoffReply() {
    return this._reply('Hmm, acho que seria melhor um(a) atendente conversar com você pessoalmente! 💚\n\nVou transferir sua conversa. Aguarda só um minutinho...');
  }
}