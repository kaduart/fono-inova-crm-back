// orchestrators/WhatsAppOrchestratorV7.js
// Orchestrator "Burro" - APENAS ROTEAMENTO
// Responsabilidade: Conectar Percepção → Cognição → Ação → Apresentação

import Logger from '../services/utils/Logger.js';
import { perceptionService } from '../perception/PerceptionService.js';
import { clinicalEligibility } from '../domain/policies/ClinicalEligibility.js';
import BookingHandler from '../handlers/BookingHandler.js';
import { leadRepository } from '../infrastructure/persistence/LeadRepository.js';
import { buildDecisionContext } from '../adapters/BookingContextAdapter.js';
import { loadContext, saveContext, mergeContext, getMissingSlots } from '../services/intelligence/ContextManager.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import { THERAPY_DATA } from '../utils/therapyDetector.js';

/**
 * Orchestrator V7 - Pipeline Arquitetural
 *
 * Fluxo:
 *   1. PERCEPÇÃO   → PerceptionService (facts)
 *   2. COGNIÇÃO    → ClinicalEligibility (policies)
 *   3. ROTEAMENTO  → determineRoute() (simples switch/case)
 *   4. AÇÃO        → Handlers (BookingHandler, etc)
 *   5. PERSISTÊNCIA→ LeadRepository (commands)
 *
 * Regras:
 *   - ZERO lógica de negócio aqui
 *   - ZERO criação de mensagens (delega para builders)
 *   - Apenas conecta peças
 */
export default class WhatsAppOrchestratorV7 {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestratorV7');
  }

  async process({ lead, message }) {
    const leadId = lead?._id?.toString() || 'unknown';
    const text = message?.content || message?.text || '';

    this.logger.info('V7_START', { leadId, text: text.substring(0, 80) });

    try {
      // 1️⃣ PERCEPÇÃO: Detectar fatos (sem decisões)
      const memory = await loadContext(leadId);
      const facts = await perceptionService.analyze(text, lead, memory);
      const context = mergeContext(memory, facts.entities);

      this.logger.debug('V7_FACTS', perceptionService.summarize(facts));

      // 2️⃣ COGNIÇÃO: Validar elegibilidade clínica
      const clinicalAuth = await clinicalEligibility.validate({
        therapy: facts.therapies.primary || context.therapy,
        age: facts.entities.age || context.age,
        text,
        clinicalHistory: lead.clinicalHistory || {}
      });

      // Hard Block: Retorna imediatamente + persiste contexto clínico
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

        await leadRepository.recordAuditEvent(leadId, {
          type: 'CLINICAL_VALIDATION',
          decision: clinicalAuth.reason,
          context: { therapy: facts.therapies.primary, age: facts.entities.age }
        });

        await saveContext(leadId, context);

        return { command: 'SEND_MESSAGE', payload: { text: clinicalAuth.message } };
      }

      // Contexto clínico herdado (ex: aceitou neuropsicologia)
      if (clinicalAuth.context?.inheritedFrom) {
        context.therapy = clinicalAuth.context.therapy;
        this.logger.info('V7_INHERITED_CONTEXT', clinicalAuth.context);
      }

      // TEA priority (soft warning)
      if (clinicalAuth.priority === 'HIGH') {
        context.priority = 'HIGH';
        context.clinicalNotes = clinicalAuth.context?.clinicalPriority;
      }

      // 3️⃣ ROTEAMENTO: Determinar ação (switch/case simples)
      const route = this._determineRoute(facts, context, lead);

      this.logger.info('V7_ROUTE', { type: route.type, intent: facts.intent.type });

      // 4️⃣ AÇÃO: Executar handler apropriado
      const response = await this._executeRoute(route, { facts, context, lead, text });

      // 5️⃣ PERSISTÊNCIA: Salvar contexto
      await saveContext(leadId, context);

      this.logger.info('V7_COMPLETE', { leadId, route: route.type, responseLength: response.length });

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
   * Determina rota baseado em fatos (LÓGICA SIMPLES DE ROTEAMENTO)
   * @private
   */
  _determineRoute(facts, context, lead) {
    const { intent, flags, therapies } = facts;

    // ROTA 1: Booking Flow (já mostrou slots ou escolheu)
    if (lead.pendingSchedulingSlots || lead.pendingChosenSlot) {
      return { type: 'BOOKING_FLOW' };
    }

    // ROTA 2: Objeção
    if (flags.givingUp || flags.refusesOrDenies || intent.type === 'objection') {
      return { type: 'OBJECTION', objectionType: flags.givingUp ? 'giving_up' : 'general' };
    }

    // ROTA 3: Interrupções (preço, endereço, plano)
    if (intent.type === 'price_inquiry') return { type: 'PRICE_INQUIRY' };
    if (intent.type === 'location_inquiry') return { type: 'LOCATION_INQUIRY' };
    if (intent.type === 'insurance_inquiry') return { type: 'INSURANCE_INQUIRY' };

    // ROTA 4: Coleta de Dados (missing slots)
    const missing = getMissingSlots(context);
    if (missing.length > 0) {
      return { type: 'COLLECT_DATA', missingSlot: missing[0] };
    }

    // ROTA 5: Oferecer Agendamento (dados completos)
    if (context.therapy && context.age && context.period) {
      return { type: 'OFFER_BOOKING' };
    }

    // ROTA PADRÃO: Apresentação inicial
    return { type: 'INITIAL_GREETING' };
  }

  /**
   * Executa handler da rota (delega para especialistas)
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
        return this._handleDataCollection(route.missingSlot, context);

      case 'OFFER_BOOKING':
        return this._handleOfferBooking(context, lead, text);

      case 'INITIAL_GREETING':
      default:
        return this._handleGreeting(context);
    }
  }

  // ===========================
  // HANDLERS (Delegam para especialistas)
  // ===========================

  async _handleBookingFlow(facts, context, lead, text) {
    const decisionContext = buildDecisionContext({
      lead,
      message: text,
      context,
      slots: lead.pendingSchedulingSlots,
      chosenSlot: lead.pendingChosenSlot
    });

    const bookingResponse = await BookingHandler.execute({ decisionContext, services: {} });

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

  async _handleOfferBooking(context, lead, text) {
    const { therapy, age, period } = context;

    // Buscar slots
    const slots = await findAvailableSlots({
      therapyArea: therapy,
      preferredPeriod: period,
      patientAge: age
    });

    // Persistir slots com lock
    const lockAcquired = await leadRepository.acquireBookingLock(lead._id, 300);
    if (!lockAcquired) {
      return 'Já estou processando outro agendamento seu! Aguarda só um instante... ⏳';
    }

    await leadRepository.persistSchedulingSlots(lead._id, slots);

    // Delegar formatação para BookingHandler
    const decisionContext = buildDecisionContext({ lead, message: text, context, slots });
    const bookingResponse = await BookingHandler.execute({ decisionContext, services: {} });

    return bookingResponse.text;
  }

  _handleGreeting(context) {
    return `Oi! Sou a Amanda da Fono Inova! 😊\n\nQue bom que você entrou em contato! Me conta: tá procurando fono, psico, fisio, ou qual especialidade?`;
  }
}
