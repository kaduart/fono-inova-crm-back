// orchestrators/WhatsAppOrchestratorV7.js
// Correções aplicadas:
// 1. Tratamento de "NÃO" string nos campos pending (Bug crítico dos logs)
// 2. Validação de nome extraído (evita "Aceita Unimed")
// 3. Limitação de busca de slots (evita loop infinito)
// 4. Garantia de merge de contexto do BookingHandler

import { buildDecisionContext } from '../adapters/BookingContextAdapter.js';
import { PRICES, formatPrice, getTherapyPricing } from '../config/pricing.js';
import BookingHandler from '../handlers/BookingHandler.js';
import { leadRepository } from '../infrastructure/persistence/LeadRepository.js';
import Leads from '../models/Leads.js';
import { perceptionService } from '../perception/PerceptionService.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import { getLatestInsights } from '../services/amandaLearningService.js';
import { getMissingSlots, loadContext, saveContext } from '../services/intelligence/ContextManager.js';
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
    if (!lead) return lead;

    // Se for um Mongoose Document, preserva o _id explicitamente
    const leadId = lead._id;
    const normalized = lead.toObject ? lead.toObject() : { ...lead };

    if (leadId && !normalized._id) {
      normalized._id = leadId;
    }

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
      'é', 'e', 'eh', 'pra', 'para', 'pro', 'adulto', 'criança', 'bebê', 'bebe',
      'fono', 'psico', 'fisio', 'fonodiologo', 'fonoaudiologo', 'psicologo', 'fisioterapeuta'
    ];

    const lowerName = name.toLowerCase().trim();

    // Se começar com palavras de pergunta, não é nome
    for (const starter of invalidStarters) {
      if (lowerName.startsWith(starter)) return false;
    }

    // 🔴 ADICIONAR ESTE BLOCO: Se contém "para" + "adulto/criança" ou termos de terapia, não é nome
    if (/\b(para|pra)\s+(adulto|adultos|criança|criancas|bebe|bebê)\b/i.test(lowerName) ||
      /\b(fono|psico|fisio|fonodiologo|fonoaudiologo|psicologo|fisioterapeuta)\b/i.test(lowerName)) {
      return false;
    }

    return true;
  }

  async process({ lead, message, context: providedContext = null }) {
    try {
      lead = this._normalizeLeadState(lead);
      const leadId = lead?._id;
      const text = message?.content || message?.text || '';

      if (!leadId) {
        this.logger.warn('PROCESS_MISSING_LEAD_ID', { from: message?.from });
      }

      // 🔴 Adicionar isto:
      if (this._isHardStopMessage(text)) {
        return { command: 'NO_REPLY' }; // ou 'SEND_MESSAGE' com despedida
      }

      if (this._isCancellation(text)) {
        await this._clearSchedulingState(leadId);
        return { command: 'SEND_MESSAGE', payload: { text: 'Entendido! Cancelado aqui pra você 😊' } };
      }

      this.logger.info('V7_INTELLIGENT_START', { leadId });

      // 1. CARREGA CONTEXTO
      // 🔧 Otimização: Se o caller já passou o contexto, usa ele (evita extra DB hit)
      const memory = (providedContext && leadId) ? providedContext : await loadContext(leadId);

      // 2. ANÁLISE 
      const facts = await perceptionService.analyze(text, lead, memory);

      // 🔥 3. CONSULTA SABEDORIA HISTÓRICA (Learning Service)
      const sabedoria = await this._consultarSabedoriaHistorica(facts, text, lead, memory);
      if (sabedoria) {
        memory.wisdom = sabedoria;
      }

      // 4. ROTEAMENTO INTELIGENTE (Aqui está a mudança)
      // Se tem sabedoria específica de preço, usa ela direto
      if (sabedoria?.tipo === 'price') {
        const respostaPreco = this._montarRespostaPrecoInteligente(memory.therapy, sabedoria);
        await saveContext(leadId, memory);
        return { command: 'SEND_MESSAGE', payload: { text: respostaPreco } };
      }

      // Se é redirecionamento médico (neuropediatra), usa sabedoria
      if (sabedoria?.tipo === 'redirecionamento_medico') {
        await saveContext(leadId, memory);
        return { command: 'SEND_MESSAGE', payload: { text: sabedoria.estrategia } };
      }

      // Senão, usa o fluxo antigo (que funciona)
      const route = this._determineRoute(facts, memory, lead);
      const response = await this._executeRoute(route, { facts, context: memory, lead, text });

      await saveContext(leadId, memory);
      // No método process, antes do return final (linha 103):
      if (!response) {
        return { command: 'NO_REPLY' };
      }
      return { command: 'SEND_MESSAGE', payload: { text: response } };

    } catch (error) {
      this.logger.error('V7_CRITICAL_ERROR', { error: error.message, stack: error.stack });
      return {
        command: 'SEND_MESSAGE',
        payload: { text: 'Ops, deu um probleminha técnico aqui! 😅 Pode repetir sua mensagem?' }
      };
    }
  }


  /**
 * 🧠 Consulta o "livro de receitas" da clínica antes de responder
 */
  async _consultarSabedoriaHistorica(facts, text, lead, memory) {
    try {
      // Busca insights mais recentes (cache por 5 min para não bater toda hora)
      if (!this.insightsCache || Date.now() - this.cacheTime > 300000) {
        this.insightsCache = await getLatestInsights();
        this.cacheTime = Date.now();
      }

      if (!this.insightsCache?.data) return null;

      const { data } = this.insightsCache;
      const intencao = facts.intent?.type || '';
      const textoLower = text.toLowerCase();

      // CASO 1: Pergunta de Preço
      if (intencao === 'price_inquiry' || /preço|valor|custa|r\$/i.test(textoLower)) {
        // Detecta cenário
        const scenario = this._detectarCenarioPreco(lead, memory);

        // Busca resposta de preço para esse cenário
        const respostaPreco = data.effectivePriceResponses?.find(r =>
          r.scenario === scenario || r.scenario === 'generic'
        );

        if (respostaPreco) {
          return {
            tipo: 'price',
            respostaExemplo: respostaPreco.response,
            cenario: scenario,
            confianca: 'alta' // veio de lead que converteu
          };
        }
      }

      // CASO 2: Saudação/Início
      if (intencao === 'greeting' || /^(oi|olá|bom dia|boa tarde)/i.test(textoLower)) {
        const abertura = data.bestOpeningLines?.find(o =>
          o.leadOrigin === lead.origin || o.leadOrigin === 'desconhecida'
        );

        if (abertura) {
          return {
            tipo: 'opening',
            respostaExemplo: abertura.text,
            tom: 'acolhedor',
            origemMatch: abertura.leadOrigin
          };
        }
      }

      // CASO 3: Pergunta sobre especialidade médica (Neuropediatra, etc)
      if (/neuropediatra|neurologista|pediatra/i.test(textoLower)) {
        // Busca em successfulClosingQuestions se tem redirecionamento
        const redirecionamento = data.successfulClosingQuestions?.find(q =>
          q.question.toLowerCase().includes('neuro') ||
          q.question.toLowerCase().includes('direcion')
        );

        if (redirecionamento) {
          return {
            tipo: 'redirecionamento_medico',
            estrategia: 'Não temos médico, temos terapia',
            perguntaExemplo: redirecionamento.question,
            contexto: '_converteram_para_neuropsico'
          };
        }
      }

      return null;

    } catch (err) {
      console.error('[Orchestrator] Erro ao consultar sabedoria:', err);
      return null;
    }
  }

  /**
 * 💰 Monta resposta de preço: Valor do pricing.js + Estratégia do Learning
 */
  _montarRespostaPrecoInteligente(therapy, wisdom) {
    // 1. Pega valor REAL do pricing.js (fonte da verdade)
    const pricing = getTherapyPricing(therapy) || { avaliacao: 200 };
    const valorAtual = formatPrice(pricing.avaliacao);

    // 2. Se não tem sabedoria histórica, usa resposta padrão
    if (!wisdom || !wisdom.respostaExemplo) {
      return `A avaliação é ${valorAtual}. Trabalhamos com reembolso de plano! 💚`;
    }

    // 3. Pega o template que converteu do Learning Service
    const template = wisdom.respostaExemplo;

    // 4. Substitui o valor antigo do template pelo valor atual do pricing.js
    // Ex: Template tinha "R$ 200", pricing.js tem "R$ 250" → substitui
    let respostaFinal = template.replace(/R\$\s*[\d\.,]+/g, valorAtual);

    // 5. Se o template não tinha o emoji da clínica, adiciona
    if (!respostaFinal.includes('💚')) {
      respostaFinal += ' 💚';
    }

    return respostaFinal;
  }

  /**
   * Detecta em qual estágio está o lead para usar resposta de preço correta
   */
  _detectarCenarioPreco(lead, memory) {
    if (lead.messageCount <= 2) return 'first_contact';
    if (memory.schedulingRequested) return 'returning';
    if (lead.messageCount > 10) return 'engaged';
    return 'generic';
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
    return /^[\u{1F44D}\u{1F64F}\u{263A}\u{2764}\u{1F49A}\u{2705}]+$/u.test(lower);
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

  /**
   * Determina rota baseado em fatos
   * @private
   */
  _determineRoute(facts, context, lead) {
    if (!facts) return { type: 'INITIAL_GREETING' };
    const { intent, flags, therapies } = facts;
    if (!lead) return { type: 'INITIAL_GREETING' };

    // 🔴 Se o nome extraído é suspeito (contém "adulto", "criança", etc), ignora ele
    if (facts.entities?.patientName && /(adulto|criança|para|bebê)/i.test(facts.entities.patientName)) {
      delete facts.entities.patientName;
    }

    // Hard guard no roteador também (defesa em profundidade)
    if (facts.intent?.type === 'social_closing') {
      return { type: 'SILENT_STOP' };
    }

    // 🔧 FIX BUG #1: Usa lead já normalizado (sem "NÃO" strings)
    // Agora a verificação truthy funciona corretamente
    const inBookingFlow = lead.pendingSchedulingSlots || lead.pendingChosenSlot;

    if (inBookingFlow) {
      return { type: 'BOOKING_FLOW' };
    }

    if (flags?.givingUp || flags?.refusesOrDenies || intent?.type === 'objection') {
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
    const { therapy, wisdom } = context;

    // Se tem sabedoria histórica (aprendeu das conversas que converteram)
    if (wisdom?.tipo === 'price') {
      return this._montarRespostaPrecoInteligente(therapy, wisdom);
    }

    // Fallback: resposta hardcoded antiga (quando não tem dados no Learning ainda)
    const info = therapy ? THERAPY_DATA[therapy] : null;

    if (info) {
      return `Pra ${info.name} ${info.emoji}:\n\n${info.valor}\n\nÉ ${info.investimento} (${info.duracao})\n\nE o melhor: trabalhamos com reembolso de plano! 💚\n\nQuer que eu busque os horários?`;
    }

    return `Nossos valores:\n\n💬 Fonoaudiologia: ${PRICES.avaliacaoInicial}\n🧠 Psicologia: ${PRICES.avaliacaoInicial}\n🏃 Fisioterapia: ${PRICES.avaliacaoInicial}\n📚 Psicopedagogia: ${PRICES.avaliacaoInicial}\n🎵 Musicoterapia: ${PRICES.sessaoAvulsa}\n🧩 Neuropsicologia: ${PRICES.neuropsicologica}\n\nTrabalhamos com reembolso de plano! 💚`;
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