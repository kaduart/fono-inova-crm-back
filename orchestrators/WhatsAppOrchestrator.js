// orchestrators/WhatsAppOrchestratorV7.js
// Correções aplicadas:
// 1. Tratamento de "NÃO" string nos campos pending (Bug crítico dos logs)
// 2. Validação de nome extraído (evita "Aceita Unimed")
// 3. Limitação de busca de slots (evita loop infinito)
// 4. Garantia de merge de contexto do BookingHandler

import { buildDecisionContext } from '../adapters/BookingContextAdapter.js';
import { clinicalEligibility } from '../domain/policies/ClinicalEligibility.js';
import BookingHandler from '../handlers/BookingHandler.js';
import { leadRepository } from '../infrastructure/persistence/LeadRepository.js';
import Leads from '../models/Leads.js';
import { perceptionService } from '../perception/PerceptionService.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import { getMissingSlots, loadContext, mergeContext, saveContext } from '../services/intelligence/ContextManager.js';
import Logger from '../services/utils/Logger.js';
import { THERAPY_DATA } from '../utils/therapyDetector.js';

/**
 * Orchestrator V7 - Pipeline Arquitetural (CORRIGIDO)
 */
export default class WhatsAppOrchestratorV7 {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestratorV7');
  }

  /**
   * 🔧 FIX BUG #1: Normaliza campos pending que vêm como string "NÃO"
   * Converte strings truthy "NÃO" para null/false
   */
  _normalizeLeadState(lead) {
    const normalized = { ...lead };

    // Se for string "NÃO" ou similar, converte para null
    if (typeof normalized.pendingSchedulingSlots === 'string' &&
      normalized.pendingSchedulingSlots.toUpperCase() === 'NÃO') {
      normalized.pendingSchedulingSlots = null;
    }

    if (typeof normalized.pendingChosenSlot === 'string' &&
      normalized.pendingChosenSlot.toUpperCase() === 'NÃO') {
      normalized.pendingChosenSlot = null;
    }

    return normalized;
  }

  /**
   * 🔧 FIX BUG #2: Valida se o nome extraído é realmente um nome
   * Evita capturar "Aceita Unimed", "Tem Horario", etc.
   */
  _isValidPatientName(name) {
    if (!name || typeof name !== 'string') return false;

    const invalidStarters = [
      'aceita', 'atende', 'tem', 'faz', 'trabalha', 'valor', 'preço', 'custa',
      'quanto', 'onde', 'como', 'quando', 'qual', 'quem', 'por que', 'porquê',
      'boa', 'bom', 'olá', 'oi', 'eae', 'hey',
      // 🔴 ADICIONAR ESSAS LINHAS:
      'é', 'e', 'eh', 'pra', 'para', 'pro', 'adulto', 'criança', 'bebê', 'bebe'
    ];

    const lowerName = name.toLowerCase().trim();

    // Se começar com palavras de pergunta, não é nome
    for (const starter of invalidStarters) {
      if (lowerName.startsWith(starter)) return false;
    }

    // 🔴 ADICIONAR ESTE BLOCO: Se contém "para" + "adulto/criança", não é nome
    if (/\b(para|pra)\s+(adulto|adultos|criança|criancas|bebe|bebê)\b/i.test(lowerName)) {
      return false;
    }

    return true;
  }

  _extractAgeAdvanced(text) {
    const lower = text.toLowerCase();

    // Meses: "1 mes", "2 meses", "1 mês e 10 dias"
    const monthMatch = lower.match(/(\d+)\s*m[eê]s(es)?/i);
    if (monthMatch) {
      return parseInt(monthMatch[1]) / 12; // Converte pra anos (0.083 = 1 mês)
    }

    // Dias: "40 dias" (menos de 1 ano = 0)
    const dayMatch = lower.match(/(\d+)\s*dias?/i);
    if (dayMatch) return 0;

    // Anos: "2 anos"
    const yearMatch = lower.match(/(\d+)\s*anos?/);
    if (yearMatch) return parseInt(yearMatch[1]);

    // Número solto: "2"
    const numericMatch = text.trim().match(/^(\d+)$/);
    if (numericMatch) return parseInt(numericMatch[1]);

    return null;
  }

  async process({ lead, message }) {
    const leadId = lead?._id; // Mantém como ObjectId
    const leadIdStr = leadId?.toString() || 'unknown'; // Só pra logs
    const text = message?.content || message?.text || '';

    this.logger.info('V7_START', { leadId, text: text.substring(0, 80) });

    // 🔴 FALLBACK CRÍTICO: Se tem nome no contexto mas não tem idade, e usuário manda número = é idade
    // Isso resolve quando awaitingResponse falha em persistir
    const memory = await loadContext(leadId);
    const looksLikeAge = /^\d{1,2}$/.test(text.trim());
    const hasNameButNoAge = memory.patientName && !memory.age;

    if (looksLikeAge && hasNameButNoAge) {
      const age = this._extractAgeAdvanced(text);
      if (age !== null) {
        this.logger.info('V7_AGE_FALLBACK', { age, source: 'context_number' });
        await Leads.findByIdAndUpdate(leadId, { 'patientInfo.age': age });
        memory.age = age;
        await saveContext(leadId, memory);

        // Continua o fluxo com a idade preenchida
        const missing = getMissingSlots(memory);
        if (missing.length === 0) {
          return { command: 'SEND_MESSAGE', payload: { text: await this._handleOfferBooking(memory, lead, text) } };
        } else {
          await leadRepository.setAwaitingResponse(leadId, missing[0].field);
          return { command: 'SEND_MESSAGE', payload: { text: this._handleDataCollection(missing[0], memory) } };
        }
      }
    }

    // 🔴 HARD INTERRUPT #1: Encerramento de conversa (NUNCA entra no pipeline)
    if (this._isHardStopMessage(text)) {
      this.logger.info('V7_HARD_STOP', { reason: 'closing_message' });
      return { command: 'NO_REPLY' }; // Silêncio educado é resposta
    }

    // 🔴 HARD INTERRUPT #2: Cancelamento explícito
    if (this._isCancellation(text)) {
      await this._clearSchedulingState(leadId);
      return {
        command: 'SEND_MESSAGE',
        payload: { text: 'Tudo bem! Cancelado aqui 😊 Se precisar de algo depois, é só chamar!' }
      };
    }

    // 🔥 FIX DO LOOP: Se tem um step pendente, processa direto, não recalcula rota
    const currentStep = lead.pendingPatientInfoStep || lead.awaitingResponse;
    if (currentStep === 'age') {
      const age = this._extractAgeAdvanced(text);
      if (age !== null) {
        // Salvou idade, limpa flag
        await leadRepository.setAwaitingResponse(leadId, null);
        await Leads.findByIdAndUpdate(leadId, { 'patientInfo.age': age });
        // Continua fluxo normal agora que temos o dado
        return this.process({ lead: { ...lead, awaitingResponse: null }, message });
      } else {
        // Não entendeu, repete a pergunta específica (não recalcula)
        return {
          command: 'SEND_MESSAGE',
          payload: { text: `Não entendi direito 😅\n\n${lead.patientName || 'A criança'} tem quantos meses ou anos? (Ex: 8 meses, ou 2 anos)` }
        };
      }
    }

    if (lead.awaitingResponse === 'NAME' && text) {
      const name = this._extractNameSimple(text);
      if (name && name.length > 2 && !['tem', 'boa', 'olá'].includes(name.toLowerCase())) {
        await leadRepository.setAwaitingResponse(leadId, 'AGE');
        await Leads.findByIdAndUpdate(leadId, { 'patientInfo.fullName': name });
        return {
          command: 'SEND_MESSAGE',
          payload: { text: `Que nome lindo, ${name}! 💚\n\nE ${name} tem quantos meses ou anos?` }
        };
      } else {
        return {
          command: 'SEND_MESSAGE',
          payload: { text: `Pode me falar o nome novamente? Só o primeiro nome já ajuda 😊` }
        };
      }
    }

    try {
      // 🔧 Normaliza estado do lead antes de processar
      const normalizedLead = this._normalizeLeadState(lead);

      // 1️⃣ PERCEPÇÃO: Detectar fatos
      const facts = await perceptionService.analyze(text, normalizedLead, memory);

      if (facts.entities?.patientName && lead.awaitingResponse !== 'NAME') {
        delete facts.entities.patientName;
      }

      // 🔧 FIX: Valida nome extraído antes de merge
      if (facts.entities?.patientName && !this._isValidPatientName(facts.entities.patientName)) {
        this.logger.info('V7_INVALID_NAME_REJECTED', {
          rejectedName: facts.entities.patientName
        });
        delete facts.entities.patientName; // Remove nome inválido
      }

      const context = mergeContext(memory, facts.entities);

      this.logger.debug('V7_FACTS', perceptionService.summarize(facts));

      // 2️⃣ COGNIÇÃO: Validar elegibilidade clínica
      const clinicalAuth = await clinicalEligibility.validate({
        therapy: facts.therapies.primary || context.therapy,
        age: facts.entities.age || context.age,
        text,
        clinicalHistory: normalizedLead.clinicalHistory || {}
      });

      if (clinicalAuth.blocked) {
        if (clinicalAuth.context) {
          await leadRepository.updateClinicalContext(leadId, clinicalAuth.context);
        }
        if (clinicalAuth.escalate) {
          await leadRepository.escalateToHuman(leadId, {
            reason: clinicalAuth.reason,
            priority: 'high',
            notes: clinicalAuth.message
          });
        }
        await saveContext(leadId, context);
        return { command: 'SEND_MESSAGE', payload: { text: clinicalAuth.message } };
      }

      if (clinicalAuth.context?.inheritedFrom) {
        context.therapy = clinicalAuth.context.therapy;
      }

      if (clinicalAuth.priority === 'HIGH') {
        context.priority = 'HIGH';
        context.clinicalNotes = clinicalAuth.context?.clinicalPriority;
      }

      // 3️⃣ ROTEAMENTO: Determinar ação
      const route = this._determineRoute(facts, context, normalizedLead);

      this.logger.info('V7_ROUTE', { type: route.type, intent: facts.intent.type });

      // 4️⃣ AÇÃO: Executar handler
      const response = await this._executeRoute(route, {
        facts,
        context,
        lead: normalizedLead, // Usa lead normalizado
        text
      });

      // 5️⃣ PERSISTÊNCIA: Salvar contexto
      await saveContext(leadId, context);

      this.logger.info('V7_COMPLETE', { leadId, route: route.type, responseLength: response.length || 0 });

      return { command: 'SEND_MESSAGE', payload: { text: response } };

    } catch (error) {
      this.logger.error('V7_ERROR', { leadId, error: error.message, stack: error.stack });
      return {
        command: 'SEND_MESSAGE',
        payload: { text: 'Oi! Sou a Amanda da Fono Inova 💚 Vou pedir pra equipe te retornar, tudo bem? 😊' }
      };
    }
  }


  /**
 * Detecta mensagens que devem PARAR o pipeline imediatamente
 * Não é "intent", é "circuit breaker"
 */
  _isHardStopMessage(text = '') {
    const lower = text.toLowerCase().trim();

    // Detecta início com agradecimento/despedida
    const isClosingStart = /^(obg|obrigad[oa]|valeu|tchau|at[ée] logo|boa (tarde|noite|dia))(\s|!|☺️|🙏|👍|$)/i.test(lower);

    if (isClosingStart) {
      // Se tem "quero", "qual", "como" depois, é continuação de conversa, não encerramento
      const hasQuestion = /\b(quero|qual|como|onde|quando|vou agendar|marca)\b/i.test(lower);
      if (!hasQuestion) return true;
    }

    // Emoji puro
    return /^[👍🙏☺️❤️💚✅]+$/u.test(lower);
  }

  /**
   * Cancelamento explícito (precisa limpar estado)
   */
  _isCancellation(text = '') {
    const lower = text.toLowerCase();
    return /^(cancela|cancelar|desist|não quero mais|não vou agendar)/.test(lower);
  }

  async _clearSchedulingState(leadId) {
    await leadRepository.setAwaitingResponse(leadId, null);
    await Leads.findByIdAndUpdate(leadId, {
      $set: {
        pendingSchedulingSlots: null,
        pendingChosenSlot: null,
        pendingPatientInfoStep: null
      }
    });
  }
  _extractNameSimple(text) {
    // Remove "meu nome é", "é", etc
    let cleaned = text.replace(/^(meu nome é|é|nome|chamo|sou)\s*/i, '').trim();
    // Pega primeira parte (primeiro nome + sobrenome se tiver)
    return cleaned.split(/\s+/).slice(0, 2).join(' ');
  }

  /**
   * Determina rota baseado em fatos
   * @private
   */
  _determineRoute(facts, context, lead) {
    const { intent, flags, therapies } = facts;

    // 🔴 Se o nome extraído é suspeito (contém "adulto", "criança", etc), ignora ele
    if (facts.entities?.patientName && /(adulto|criança|para|bebê)/i.test(facts.entities.patientName)) {
      delete facts.entities.patientName;
    }

    // Hard guard no roteador também (defesa em profundidade)
    if (facts.intent.type === 'social_closing') {
      return { type: 'SILENT_STOP' };
    }

    // 🔧 FIX BUG #1: Usa lead já normalizado (sem "NÃO" strings)
    // Agora a verificação truthy funciona corretamente
    const inBookingFlow = lead.pendingSchedulingSlots || lead.pendingChosenSlot;

    if (inBookingFlow) {
      return { type: 'BOOKING_FLOW' };
    }

    if (flags.givingUp || flags.refusesOrDenies || intent.type === 'objection') {
      return { type: 'OBJECTION', objectionType: flags.givingUp ? 'giving_up' : 'general' };
    }

    if (intent.type === 'price_inquiry') return { type: 'PRICE_INQUIRY' };
    if (intent.type === 'location_inquiry') return { type: 'LOCATION_INQUIRY' };
    if (intent.type === 'insurance_inquiry') return { type: 'INSURANCE_INQUIRY' };

    const missing = getMissingSlots(context);
    if (missing.length > 0) {
      return { type: 'COLLECT_DATA', missingSlot: missing[0] };
    }

    if (context.therapy && context.age && context.period) {
      return { type: 'OFFER_BOOKING' };
    }

    return { type: 'INITIAL_GREETING' };
  }

  /**
   * Executa handler da rota
   * @private
   */
  async _executeRoute(route, { facts, context, lead, text }) {
    switch (route.type) {
      case 'BOOKING_FLOW':
        return this._handleBookingFlow(facts, context, lead, text);

      case 'OBJECTION':
        return this._handleObjection(route.objectionType, context);

      case 'PRICE_INQUIRY':
        return this._handlePriceInquiry(context);

      case 'LOCATION_INQUIRY':
        return this._handleLocationInquiry();

      case 'INSURANCE_INQUIRY':
        return this._handleInsuranceInquiry();

      case 'COLLECT_DATA':
        await leadRepository.setAwaitingResponse(lead._id, route.missingSlot.field);

        return this._handleDataCollection(route.missingSlot, context);

      case 'OFFER_BOOKING':
        return this._handleOfferBooking(context, lead, text);

      case 'SILENT_STOP':
        this.logger.info('V7_SILENT_STOP');
        return null; // ou { command: 'NO_REPLY' }

      case 'INITIAL_GREETING':
      default:
        return this._handleGreeting(context);
    }
  }

  async _handleBookingFlow(facts, context, lead, text) {
    const decisionContext = buildDecisionContext({
      lead,
      message: text,
      context,
      slots: lead.pendingSchedulingSlots,
      chosenSlot: lead.pendingChosenSlot
    });

    const bookingResponse = await BookingHandler.execute({ decisionContext, services: {} });

    // 🔧 FIX: Garante merge de dados extraídos pelo BookingHandler
    if (bookingResponse.extractedInfo) {
      Object.assign(context, bookingResponse.extractedInfo);
    }

    return bookingResponse.text;
  }

  _handleObjection(objectionType, context) {
    const messages = {
      giving_up: 'Tudo bem! Sem pressão nenhuma 😊\n\nSe mudar de ideia, é só chamar! Estamos aqui pra ajudar 💚',
      price: 'Entendo sua preocupação com o investimento! 💚\n\nTrabalhamos com reembolso de plano (geralmente 80-100%) e parcelamento no cartão! Quer que eu busque os horários?',
      general: 'Entendo! Se tiver alguma dúvida, pode me contar que vejo como posso ajudar 💚'
    };

    return messages[objectionType] || messages.general;
  }

  _handlePriceInquiry(context) {
    const { therapy } = context;
    const info = therapy ? THERAPY_DATA[therapy] : null;

    if (info) {
      return `Pra ${info.name} ${info.emoji}:\n\n${info.valor}\n\nÉ ${info.investimento} (${info.duracao})\n\nE o melhor: trabalhamos com reembolso de plano! 💚\n\nQuer que eu busque os horários?`;
    }

    return `Nossos valores:\n\n💬 Fonoaudiologia: R$ 200\n🧠 Psicologia: R$ 200\n🏃 Fisioterapia: R$ 200\n📚 Psicopedagogia: R$ 200\n🎵 Musicoterapia: R$ 180\n🧩 Neuropsicologia: R$ 400\n\nTrabalhamos com reembolso de plano! 💚`;
  }

  _handleLocationInquiry() {
    return `📍 Ficamos na Av. Brasil, 1234 - Centro de Anápolis/GO.\n\nTem estacionamento fácil na rua e estacionamento pago perto! 🚗\n\nQuer agendar uma avaliação?`;
  }

  _handleInsuranceInquiry() {
    return `Trabalhamos com reembolso de todos os planos! Você paga e solicita o ressarcimento (geralmente entre 80% e 100%).\n\nTambém aceitamos Pix, cartão de crédito e débito! 😊\n\nQuer marcar uma avaliação?`;
  }

  _handleDataCollection(missingSlot, context) {
    const questions = {
      therapy: 'Me conta: tá procurando fono, psico, fisio, ou qual especialidade?',
      complaint: `Sobre ${context.therapy}, me conta um pouco da situação que tá preocupando?`,
      age: `E qual a idade${context.patientName ? ` de ${context.patientName}` : ''}?`,
      period: 'Que período funciona melhor: **manhã ou tarde**? (Horário: 8h às 18h)',
      patientName: 'Pra eu organizar aqui, qual o nome do pequeno?'
    };

    return questions[missingSlot.field] || 'Me conta mais alguns detalhes? 😊';
  }

  /**
   * 🔧 FIX BUG #3: Limitação de busca de slots
   * Evita loop infinito de requisições
   */
  async _handleOfferBooking(context, lead, text) {
    const { therapy, age, period } = context;

    // 🔥 Limita a busca: máximo 3 dias, 2 médicos por vez
    const searchOptions = {
      therapyArea: therapy,
      preferredPeriod: period,
      patientAge: age,
      maxDoctors: 2,        // Limita número de médicos
      maxDays: 3,           // Limita dias futuros
      timeoutMs: 5000       // Timeout total
    };

    let slots;
    try {
      slots = await Promise.race([
        findAvailableSlots(searchOptions),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SLOT_SEARCH_TIMEOUT')), 5000)
        )
      ]);
    } catch (error) {
      this.logger.error('V7_SLOT_SEARCH_ERROR', { error: error.message });
      // Fallback: mostra mensagem genérica mas útil
      return `Estou verificando a agenda dos nossos profissionais de ${THERAPY_DATA[therapy]?.name || 'terapia'} 💚\n\nPode ser que eu precise de mais um instante... Enquanto isso, prefere atendimento presencial ou online?`;
    }

    // Persistir slots com lock
    const lockAcquired = await leadRepository.acquireBookingLock(lead._id, 300);
    if (!lockAcquired) {
      return 'Já estou processando outro agendamento seu! Aguarda só um instante... ⏳';
    }

    // 🔧 Só persiste se tiver slots válidos
    if (slots?.primary?.length > 0) {
      await leadRepository.persistSchedulingSlots(lead._id, slots);
    }

    // Delegar formatação para BookingHandler
    const decisionContext = buildDecisionContext({ lead, message: text, context, slots });
    const bookingResponse = await BookingHandler.execute({ decisionContext, services: {} });

    return bookingResponse.text;
  }

  _handleGreeting(context) {
    return `Oi! Sou a Amanda da Fono Inova! 😊\n\nQue bom que você entrou em contato! Me conta: tá procurando fono, psico, fisio, ou qual especialidade?`;
  }
}