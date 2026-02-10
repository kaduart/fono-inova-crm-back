import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import { detectAllFlags } from '../utils/flagsDetector.js';
import { detectAllTherapies } from '../utils/therapyDetector.js';
import { clinicalRulesEngine } from '../services/intelligence/clinicalRulesEngine.js';
import BookingHandler from '../handlers/BookingHandler.js';
import { buildDecisionContext, mergeBookingDataToContext } from '../adapters/BookingContextAdapter.js';

// 🆕 NOVO SISTEMA DE CONTEXT E ENTITIES
import { extractEntities } from '../services/intelligence/EntityExtractor.js';
import {
  loadContext,
  saveContext,
  mergeContext,
  getMissingSlots,
  hasCompleteInfo
} from '../services/intelligence/ContextManager.js';

// =============================================================================
// 🧠 WHATSAPP ORCHESTRATOR V6.1 - Entity-Based com ContextManager
// =============================================================================
// REFATORAÇÃO: Usa EntityExtractor robusto + ContextManager para merge inteligente
// Isso evita o bug de "2 anos" sobrescrever "Ana Clara"
// =============================================================================

// Dados das terapias
const THERAPY_DATA = {
  fonoaudiologia: {
    name: 'Fonoaudiologia',
    emoji: '💬',
    valor: 'Na avaliação, vamos entender exatamente como está a comunicação, identificar pontos fortes e desafios, e traçar um plano personalizado para o pequeno evoluir! É um momento super completo e acolhedor 🥰',
    investimento: 'R$ 200',
    duracao: '1h a 1h30',
    acolhimento: 'Fonoaudiologia é maravilhosa para ajudar na comunicação! 💬'
  },
  psicologia: {
    name: 'Psicologia',
    emoji: '🧠',
    valor: 'A primeira consulta é um espaço seguro para você se sentir ouvido e compreendido. Vamos entender o que está acontecendo e começar a trilhar juntos um caminho de bem-estar emocional 💚',
    investimento: 'R$ 200',
    duracao: '50 minutos',
    acolhimento: 'Cuidar da mente é um ato de amor! 🧠💚'
  },
  fisioterapia: {
    name: 'Fisioterapia',
    emoji: '🏃',
    valor: 'Na avaliação, fazemos uma análise completa da postura, movimentos e identificamos o que está causando o desconforto. Você já sai com orientações práticas para melhorar! 💪',
    investimento: 'R$ 200',
    duracao: '1 hora',
    acolhimento: 'Vamos cuidar desse corpinho com carinho! 🏃💚'
  },
  terapia_ocupacional: {
    name: 'Terapia Ocupacional',
    emoji: '🤲',
    valor: 'Avaliamos as habilidades do dia a dia, coordenação motora e como a criança interage com o mundo. Identificamos pontos de apoio para ela se desenvolver com mais autonomia! 🌟',
    investimento: 'R$ 200',
    duracao: '1 hora',
    acolhimento: 'A terapia ocupacional ajuda muito no dia a dia! 🤲'
  },
  psicopedagogia: {
    name: 'Psicopedagogia',
    emoji: '📚',
    valor: 'Vamos entender como a criança aprende de forma única! Identificamos estratégias personalizadas para transformar estudos em algo leve e prazeroso, respeitando o ritmo dela 📖✨',
    investimento: 'R$ 200',
    duracao: '50 minutos',
    acolhimento: 'Aprender pode ser leve e prazeroso! 📚✨'
  },
  neuropsicologia: {
    name: 'Neuropsicologia',
    emoji: '🧩',
    valor: 'Avaliação super completa das funções cerebrais: atenção, memória, raciocínio... Essencial para entender o funcionamento cognitivo e planejar o melhor caminho! 🧠',
    investimento: 'R$ 400',
    duracao: '2 a 3 horas',
    acolhimento: 'A avaliação neuropsicológica é um passo importante! 🧩'
  },
  musicoterapia: {
    name: 'Musicoterapia',
    emoji: '🎵',
    valor: 'Usamos a música como ponte para o desenvolvimento emocional, comunicação e coordenação! A avaliação é lúdica, acolhedora e revela muito sobre o potencial da criança 🎶',
    investimento: 'R$ 180',
    duracao: '50 minutos',
    acolhimento: 'A música tem um poder transformador! 🎵💚'
  }
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

    // Guarda lead e message para uso em métodos internos (delegação ao BookingHandler)
    this.currentLead = lead;
    this.currentMessage = message;
    this.currentText = text;

    this.logger.info('V6_ENTITY_START', { leadId, text: text.substring(0, 80) });

    try {
      // 1. 🔄 CARREGA CONTEXTO DO BANCO (novo sistema)
      const memory = await loadContext(leadId);
      
      // 2. 🔍 EXTRAI ENTIDADES (novo sistema robusto)
      const extracted = extractEntities(text, memory);

      // 2.5 🚩 ENRIQUECE COM FLAGS (objeções, urgência, TEA, etc.)
      const flags = detectAllFlags(text, lead, memory);
      extracted.flags = flags;

      this.logger.debug('FLAGS_ENRICHMENT', {
        leadId,
        activeFlags: Object.keys(flags).filter(k => flags[k] === true).length,
        userProfile: flags.userProfile,
        topic: flags.topic,
        teaStatus: flags.teaStatus
      });

      // 3. 🧠 MERGE INTELIGENTE (preserva dados válidos)
      const context = mergeContext(memory, extracted);

      // 3.5 ✅ VALIDAÇÃO CLÍNICA (especialidades médicas, age gates)
      const eligibility = clinicalRulesEngine({
        memoryContext: context,
        analysis: { extractedInfo: extracted, detectedTherapy: context.therapy },
        text: text
      });

      if (eligibility.blocked) {
        // Hard block - retorna imediatamente sem prosseguir
        this.logger.info('CLINICAL_BLOCK', {
          leadId,
          reason: eligibility.reason,
          specialty: eligibility.specialty
        });

        await saveContext(leadId, context);

        return {
          command: 'SEND_MESSAGE',
          payload: { text: eligibility.message }
        };
      }

      // Guarda soft warnings para usar depois se necessário
      context.eligibilityWarnings = eligibility.message ? [eligibility.message] : [];

      // 4. 🎯 DECIDE AÇÃO (passa text original para detectar especialidades não atendidas)
      const action = this.decideNextAction(context, extracted, text);
      context.lastAction = action.type;
      
      // Atualiza step atual
      const missing = getMissingSlots(context);
      context.currentStep = missing.length > 0 ? `missing_${missing[0].field}` : 'complete';

      this.logger.info('V6_ENTITY_CONTEXT', {
        leadId,
        therapy: context.therapy,
        patientName: context.patientName,
        age: context.age,
        period: context.period,
        intencao: context.intencao,
        action: action.type,
        missingSlots: missing.length
      });

      // 5. 💬 GERA RESPOSTA
      const response = await this.generateResponse(text, context, action, extracted);

      // 6. 💾 SALVA CONTEXTO ATUALIZADO
      await saveContext(leadId, context);

      this.logger.info('V6_ENTITY_COMPLETE', { 
        leadId, 
        action: action.type, 
        responseLength: response?.length
      });
      
      return { command: 'SEND_MESSAGE', payload: { text: response } };

    } catch (error) {
      this.logger.error('V6_ENTITY_ERROR', { leadId, error: error.message, stack: error.stack });
      
      return {
        command: 'SEND_MESSAGE',
        payload: { text: 'Oi! Sou a Amanda da Fono Inova 💚 Que bom que entrou em contato! 😊\n\nMe conta: é para você ou para um pequeno? Qual situação vocês estão enfrentando?' }
      };
    }
  }

  /**
   * 🎯 Decide a próxima ação baseada no contexto
   */
  decideNextAction(context, extracted, originalText = '') {
    const missing = getMissingSlots(context);
    const intencao = extracted.intencao || context.lastIntencao || 'informacao';
    const flags = context.flags || extracted.flags || {};

    // ✅ Especialidades não atendidas já tratadas pelo clinicalRulesEngine (bloqueia antes de chegar aqui)

    // PRIORIDADE 1: Bloqueios clínicos (soft warnings)
    if (context.eligibilityWarnings?.length > 0) {
      return { type: 'RESPONSE_ELIGIBILITY_WARNING', missingAfter: missing };
    }

    // PRIORIDADE 2: Interrupções (preço, plano, endereço) - usa FLAGS
    if (flags.asksPrice && context.therapy) {
      return { type: 'RESPONSE_PRECO', missingAfter: missing };
    }

    if (flags.asksPlans || intencao === 'plano') {
      return { type: 'RESPONSE_PLANO', missingAfter: missing };
    }

    if (flags.asksAddress || flags.asksLocation || intencao === 'endereco') {
      return { type: 'RESPONSE_ENDERECO', missingAfter: missing };
    }

    // PRIORIDADE 3: Objeções e desistência
    if (flags.givingUp || flags.refusesOrDenies) {
      return { type: 'HANDLE_OBJECTION', objectionType: this.detectObjectionType(flags), missingAfter: missing };
    }

    if (intencao === 'agendamento' && missing.length === 0) {
      return { type: 'EXECUTE_AGENDAMENTO', missingAfter: [] };
    }

    // ✨ NOVO: Se detectou terapia MAS não tem queixa ainda E é uma pergunta sobre informação/disponibilidade
    // Responder primeiro antes de coletar dados
    if (context.therapy && !context.complaint && intencao === 'informacao' && context.messageCount <= 1) {
      return { type: 'RESPONSE_DISPONIBILIDADE', missingAfter: missing };
    }

    // Fluxo normal: preencher slots faltantes
    if (missing.length > 0) {
      return {
        type: 'ASK_SLOT',
        slot: missing[0].field,
        questionType: missing[0].question,
        missingCount: missing.length
      };
    }

    // Tudo preenchido, oferecer agendamento
    return { type: 'OFFER_AGENDAMENTO', missingAfter: [] };
  }

  /**
   * 🚨 Detecta tipo de objeção baseado em flags
   */
  detectObjectionType(flags) {
    if (flags.mentionsPriceObjection || flags.insistsPrice) return 'price';
    if (flags.mentionsTimeObjection) return 'time';
    if (flags.mentionsInsuranceObjection) return 'insurance';
    if (flags.givingUp) return 'giving_up';
    if (flags.refusesOrDenies) return 'refusal';
    return 'general';
  }

  /**
   * 💬 Gera resposta baseada na ação
   */
  async generateResponse(text, ctx, action, extracted) {
    const { therapy, complaint, age, period, patientName, tipo_paciente, flags } = ctx;

    // 1. Tratar interrupções (preço, plano, endereço)
    if (flags?.asksPrice || action.type === 'RESPONSE_PRECO') {
      const response = this.responderInterrupcao(ctx, 'preco');
      this.logger.info('GENERATE_RESPONSE_PRECO', {
        therapy: ctx.therapy,
        responseLength: response?.length,
        responsePreview: response?.substring(0, 150)
      });
      return response;
    }

    if (flags?.asksPlans || action.type === 'RESPONSE_PLANO') {
      const response = this.responderInterrupcao(ctx, 'plano');
      this.logger.info('GENERATE_RESPONSE_PLANO', { responseLength: response?.length });
      return response;
    }

    if (flags?.asksAddress || action.type === 'RESPONSE_ENDERECO') {
      const response = this.responderInterrupcao(ctx, 'endereco');
      this.logger.info('GENERATE_RESPONSE_ENDERECO', { responseLength: response?.length });
      return response;
    }

    // 🚨 NOVO: Tratar objeções detectadas por flags
    if (action.type === 'HANDLE_OBJECTION') {
      this.logger.info('HANDLE_OBJECTION', { objectionType: action.objectionType });
      return this.handleObjection(ctx, action.objectionType);
    }

    // ✨ NOVO: Responder pergunta sobre disponibilidade ANTES de coletar dados
    if (action.type === 'RESPONSE_DISPONIBILIDADE') {
      return this.responderDisponibilidade(ctx);
    }

    // 🔧 FIX BUG #1: Responder educadamente para especialidades não atendidas
    if (action.type === 'RESPONSE_TERAPIA_NAO_ATENDIDA') {
      return this.responderEspecialidadeNaoAtendida(action.especialidade, ctx);
    }

    // 2. Fluxo entity-based
    if (action.type === 'ASK_SLOT') {
      return this.askForSlot(ctx, action.slot, action.questionType, extracted);
    }

    // 🆕 BOOKING FLOW DELEGATION: Se já mostrou slots ou tem slot escolhido, delega ao BookingHandler
    const inBookingFlow = !!this.currentLead?.pendingSchedulingSlots || !!this.currentLead?.pendingChosenSlot;

    if (inBookingFlow) {
      this.logger.info('BOOKING_FLOW_DELEGATION', {
        hasSlots: !!this.currentLead?.pendingSchedulingSlots,
        hasChosenSlot: !!this.currentLead?.pendingChosenSlot,
        hasName: !!ctx.patientName
      });

      const decisionContext = buildDecisionContext({
        lead: this.currentLead,
        message: this.currentText,
        context: ctx,
        slots: this.currentLead?.pendingSchedulingSlots,
        chosenSlot: this.currentLead?.pendingChosenSlot
      });

      const bookingResponse = await BookingHandler.execute({ decisionContext, services: {} });

      // Atualizar contexto com dados extraídos pelo BookingHandler
      if (bookingResponse.extractedInfo) {
        Object.assign(ctx, bookingResponse.extractedInfo);
      }

      return bookingResponse.text;
    }

    // Fluxo pré-booking: coleta therapy, complaint, age, period
    // Se detectou entidade nova, valida e pergunta próxima
    if (extracted.patientName && !ctx.askedForAge) {
      ctx.askedForName = true;
      return this.acknowledgeAndAskNext(ctx, 'name', extracted);
    }

    if (extracted.age && ctx.patientName && !ctx.askedForPeriod) {
      ctx.askedForAge = true;
      return this.acknowledgeAndAskNext(ctx, 'age', extracted);
    }

    if (extracted.period && ctx.age && !ctx.askedForConfirmation) {
      ctx.askedForPeriod = true;
      return this.acknowledgeAndAskNext(ctx, 'period', extracted);
    }

    // Se tudo completo
    if (action.type === 'OFFER_AGENDAMENTO') {
      // 🔧 FIX BUG #3: Se detectou negação real (usuário desistiu), não força agendamento
      if (ctx.isNegation && !ctx.complaint) {
        return `Tudo bem! Sem problemas! 😊\n\nFico à disposição quando você quiser agendar. Qualquer dúvida, é só me chamar! Estou aqui para ajudar! 💚`;
      }

      // 🔧 FIX BUG #2: SEMPRE busca horários e delega ao BookingHandler
      if (therapy && age && period) {
        this.logger.info('DELEGATING_TO_BOOKING_HANDLER_OFFER', { therapy, age, period });

        // Buscar slots
        const slots = await findAvailableSlots({
          therapyArea: therapy,
          preferredPeriod: period,
          patientAge: age
        });

        // Delegar ao BookingHandler
        const decisionContext = buildDecisionContext({
          lead: this.currentLead,
          message: this.currentText,
          context: ctx,
          slots
        });

        const bookingResponse = await BookingHandler.execute({ decisionContext, services: {} });
        return bookingResponse.text;
      }

      // Fallback se faltar algum dado (não deveria chegar aqui)
      const info = THERAPY_DATA[therapy];
      return `Maravilha! 🎉 Vou verificar os horários disponíveis para ${info?.name || 'a consulta'}...`;
    }

    return this.fallbackResponse(ctx);
  }

  /**
   * ❓ Pergunta por um slot específico
   */
  askForSlot(ctx, slot, questionType, extracted) {
    const { therapy, patientName, age, tipo_paciente } = ctx;
    const info = therapy ? THERAPY_DATA[therapy] : null;
    const isCrianca = tipo_paciente === 'crianca' || (age && age < 12);

    switch (slot) {
      case 'therapy':
        return `Oi! Sou a Amanda da Fono Inova! 😊\n\nQue bom que você entrou em contato! Me conta: tá procurando fono, psico, fisio, ou qual especialidade?`;

      case 'complaint':
        if (therapy === 'fonoaudiologia') {
          return `Entendi que é pra fono! 💬\n\nMe conta mais sobre a situação: o pequeno ainda não fala nada, fala algumas palavrinhas, ou tem alguma dificuldade que você notou?`;
        }
        if (therapy === 'psicologia') {
          return isCrianca
            ? `Sobre psico pra criança 🧠\n\nMe conta como tá a situação... Tem dificuldade de atenção na escola, comportamento, ou algo que tá te preocupando?`
            : `Sobre psicologia 🧠\n\nMe conta como você tá se sentindo... Tem ansiedade, dificuldade pra dormir, ou algo que tá incomodando?`;
        }
        return `Perfeito! ${info?.emoji || ''}\n\nMe conta mais sobre o que tá preocupando. Quero entender direitinho pra poder ajudar!`;

      case 'patientName':
        if (!extracted?.patientName) {
          const sujeito = isCrianca ? 'o pequeno' : (therapy === 'psicologia' ? 'a criança' : 'paciente');
          return `Pra eu organizar aqui, me conta: qual o nome ${sujeito === 'paciente' ? 'do' : 'do'} ${sujeito}?`;
        }
        return `Que nome lindo, ${extracted.patientName}! 🥰\n\nE quantos anos ${extracted.patientName} tem?`;

      case 'age':
        if (patientName) {
          return `Que nome lindo, ${patientName}! 🥰\n\nE ${patientName} tem quantos aninhos?`;
        }
        return `E quantos anos ${isCrianca ? 'o pequeno' : 'você'} tem?`;

      case 'period':
        return `Perfeito! 🌟\n\nPra ${info?.name?.toLowerCase() || 'atendimento'}, temos ótimos profissionais. Que período funciona melhor: **manhã ou tarde**? 😊`;

      default:
        return this.fallbackResponse(ctx);
    }
  }

  /**
   * ✅ Valida o que recebeu e pergunta o próximo
   */
  async acknowledgeAndAskNext(ctx, receivedField, extracted) {
    const { therapy, patientName, age, period, tipo_paciente } = ctx;
    const info = therapy ? THERAPY_DATA[therapy] : null;
    const isCrianca = tipo_paciente === 'crianca' || (age && age < 12);

    // Recebemos NOME → pergunta IDADE
    if (receivedField === 'name' && patientName) {
      return `Que nome lindo, ${patientName}! 🥰\n\nE ${patientName} tem quantos aninhos?`;
    }

    // Recebemos IDADE → pergunta PERÍODO
    if (receivedField === 'age' && age) {
      let acolhimento = '';
      if (age <= 3) acolhimento = `Que fofa! ${age} aninhos é uma fase tão especial! 🥰`;
      else if (age <= 12) acolhimento = `${age} anos! Que fase linda! 🌟`;
      else if (age <= 17) acolhimento = `Adolescência, né? Uma fase de muitas transformações 💚`;
      else acolhimento = `Perfeito! Vamos cuidar bem de você! 💚`;

      return `${acolhimento}\n\nPra ${info?.name?.toLowerCase() || 'atendimento'}, temos ótimos profissionais. Que período funciona melhor: **manhã ou tarde**? 😊`;
    }

    // Recebemos PERÍODO → 🔧 FIX: BUSCA SLOTS E DELEGA AO BOOKINGHANDLER!
    if (receivedField === 'period' && period && therapy && age) {
      const periodoTexto = period === 'manha' ? 'manhã' : period;
      this.logger.info('DELEGATING_TO_BOOKING_HANDLER_SLOTS', { therapy, age, period });

      // Buscar slots
      const slots = await findAvailableSlots({
        therapyArea: therapy,
        preferredPeriod: period,
        patientAge: age
      });

      // Delegar formatação e exibição ao BookingHandler
      const decisionContext = buildDecisionContext({
        lead: this.currentLead,
        message: this.currentText,
        context: ctx,
        slots
      });

      const bookingResponse = await BookingHandler.execute({ decisionContext, services: {} });
      return bookingResponse.text;
    }

    // Fallback se só recebeu período mas falta outros dados
    if (receivedField === 'period' && period) {
      const periodoTexto = period === 'manha' ? 'manhã' : period;
      return `Perfeito! Anotado ${periodoTexto}! ✅\n\nAgora deixa eu ver os horários...`;
    }

    return this.fallbackResponse(ctx);
  }

  /**
   * 🆘 Resposta fallback
   */
  fallbackResponse(ctx) {
    const { therapy, patientName } = ctx;

    if (!therapy) {
      return `Oi! Sou a Amanda da Fono Inova 💚 Que bom que você entrou em contato! 😊\n\nMe conta: tá procurando fono, psico, fisio, ou qual especialidade?`;
    }

    return `Entendi! 😊\n\nMe conta: qual a principal questão que ${patientName || 'vocês'} ${patientName ? 'tá' : 'tão'} enfrentando? Tô aqui pra ajudar!`;
  }

  /**
   * ✨ Resposta para pergunta sobre disponibilidade
   * Responde SIM/NÃO e então pergunta sobre a queixa
   */
  responderDisponibilidade(ctx) {
    const { therapy, tipo_paciente } = ctx;
    const info = therapy ? THERAPY_DATA[therapy] : null;

    if (!info) {
      return `Oi! Sou a Amanda da Fono Inova! 😊\n\nQue bom que você entrou em contato! A gente trabalha com várias especialidades. Me conta: qual atendimento você tá procurando?`;
    }

    const isCrianca = tipo_paciente === 'crianca';

    // Confirma que tem a especialidade
    let resposta = `Sim, temos ${info.name}! ${info.emoji} ${info.acolhimento}\n\n`;

    // Pergunta sobre a queixa/situação
    if (therapy === 'fonoaudiologia') {
      resposta += `Me conta mais sobre a situação: o pequeno ainda não fala nada, fala algumas palavrinhas, ou tem alguma dificuldade específica que você notou?`;
    } else if (therapy === 'psicologia') {
      if (isCrianca) {
        resposta += `Me conta como tá a situação da criança... Tem dificuldade de atenção, comportamento, ou algo que tá te preocupando?`;
      } else {
        resposta += `Me conta como você tá se sentindo ultimamente... Tem ansiedade, dificuldade pra dormir, ou algo que tá incomodando?`;
      }
    } else if (therapy === 'fisioterapia') {
      resposta += `Me conta sobre o que tá sentindo... É dor na coluna, no joelho, ou algum desconforto específico?`;
    } else {
      resposta += `Me conta mais sobre a situação que tá preocupando. Quero entender direitinho pra poder ajudar!`;
    }

    return resposta;
  }

  /**
   * 🔄 Resposta de interrupção
   */
  responderInterrupcao(ctx, tipo) {
    const { therapy, patientName } = ctx;

    let resposta = '';

    switch (tipo) {
      case 'preco':
        if (therapy) {
          const info = THERAPY_DATA[therapy];
          resposta = `Pra ${info.name} ${info.emoji}:\n\n${info.valor}\n\nÉ ${info.investimento} (${info.duracao})\n\nE o melhor: trabalhamos com reembolso de plano! 💚`;
        } else {
          resposta = `As avaliações aqui são bem completas! A gente entende a necessidade e monta um plano personalizado 💚\n\n💬 Fonoaudiologia: R$ 200\n🧠 Psicologia: R$ 200\n🏃 Fisioterapia: R$ 200\n📚 Psicopedagogia: R$ 200\n🎵 Musicoterapia: R$ 180\n🧩 Neuropsicologia: R$ 400\n\nTrabalhamos com reembolso de plano!`;
        }
        break;

      case 'plano':
        resposta = `Trabalhamos com reembolso de todos os planos! Você paga e solicita o ressarcimento (geralmente entre 80% e 100%). Também aceitamos Pix, cartão de crédito e débito! 😊`;
        break;

      case 'endereco':
        resposta = `📍 Ficamos na Av. Brasil, 1234 - Centro de Anápolis/GO. Tem estacionamento fácil na rua e estacionamento pago perto! 🚗`;
        break;
    }

    // Retomada inteligente
    const missing = getMissingSlots(ctx);
    let perguntaRetomada = '';

    this.logger.info('INTERRUPCAO_RETOMADA', {
      tipo,
      therapy: ctx.therapy,
      missingCount: missing.length,
      missingFields: missing.map(m => m.field),
      nextSlot: missing[0]?.field
    });

    if (missing.length === 0) {
      perguntaRetomada = `\n\nVou verificar os horários disponíveis! Posso buscar para você?`;
    } else {
      const nextSlot = missing[0];

      switch (nextSlot.field) {
        case 'therapy':
          perguntaRetomada = `\n\nE me conta: você está buscando atendimento para fonoaudiologia, psicologia, ou qual especialidade?`;
          break;
        case 'complaint':
          const info = therapy ? THERAPY_DATA[therapy] : null;
          perguntaRetomada = `\n\n${info ? `Para ${info.name.toLowerCase()}, ` : ''}me conta um pouco sobre a situação que está preocupando?`;
          break;
        case 'patientName':
          perguntaRetomada = `\n\nPara eu organizar aqui, qual é o nome ${therapy === 'psicologia' ? 'da criança' : 'do paciente'}?`;
          break;
        case 'age':
          perguntaRetomada = `\n\nE qual a idade${patientName ? ` de ${patientName}` : ''}? Para eu verificar os melhores profissionais!`;
          break;
        case 'period':
          perguntaRetomada = `\n\nQual período funciona melhor: **manhã ou tarde**? (Horário: 8h às 18h)`;
          break;
        default:
          perguntaRetomada = `\n\nTem mais alguma informação que gostaria de me passar?`;
      }
    }

    const finalResponse = resposta + perguntaRetomada;

    this.logger.info('INTERRUPCAO_RESPONSE', {
      tipo,
      respostaLength: resposta.length,
      perguntaRetomadaLength: perguntaRetomada.length,
      finalLength: finalResponse.length,
      hasPergunta: perguntaRetomada.length > 0
    });

    return finalResponse;
  }

  /**
   * 🚨 Trata objeções do usuário (desistência, recusa, etc.)
   */
  handleObjection(ctx, objectionType) {
    const { therapy, patientName } = ctx;
    let resposta = '';

    this.logger.info('HANDLING_OBJECTION', { objectionType, therapy, hasName: !!patientName });

    switch (objectionType) {
      case 'price':
        resposta = `Entendo sua preocupação com o investimento! 💚\n\n`;
        resposta += `A gente sabe que é importante cuidar da saúde de forma acessível. `;
        resposta += `Por isso trabalhamos com reembolso de plano (geralmente entre 80% e 100%).\n\n`;
        resposta += `Também temos opções de parcelamento no cartão! Quer que eu busque os horários mesmo assim?`;
        break;

      case 'time':
        resposta = `Entendo que o tempo tá corrido! ⏰\n\n`;
        resposta += `A gente tem horários flexíveis de **manhã e tarde** (8h às 18h). `;
        resposta += `Qual período funcionaria melhor pra você?`;
        break;

      case 'insurance':
        resposta = `Sobre o plano de saúde: trabalhamos com **reembolso** de todos os planos! 💚\n\n`;
        resposta += `Você paga a sessão e depois solicita o reembolso direto com seu plano. `;
        resposta += `A maioria dos nossos pacientes consegue de 80% a 100% de volta.\n\n`;
        resposta += `Quer que eu busque os horários disponíveis?`;
        break;

      case 'giving_up':
      case 'refusal':
        resposta = `Tudo bem! Sem pressão nenhuma 😊\n\n`;
        resposta += `Se mudar de ideia ou tiver alguma dúvida, é só chamar! Estamos aqui pra ajudar 💚`;
        break;

      case 'general':
      default:
        resposta = `Entendo! Se tiver alguma preocupação, pode me contar que vejo como posso ajudar 💚\n\n`;
        resposta += `Quer que eu busque os horários disponíveis mesmo assim?`;
    }

    return resposta;
  }

  /**
   * 🚫 Resposta para especialidades que NÃO atendemos
   */
  responderEspecialidadeNaoAtendida(especialidade, ctx) {
    const missing = getMissingSlots(ctx);

    let resposta = '';

    // Respostas específicas por especialidade
    if (especialidade.includes('neurolog')) {
      resposta = `Entendi que você tá buscando **neurologista** 🧠\n\n`;
      resposta += `Aqui na Fono Inova a gente trabalha com **Neuropsicologia** (avaliação das funções cerebrais como atenção, memória, raciocínio), `;
      resposta += `mas pra acompanhamento neurológico médico, você vai precisar consultar um neurologista clínico.\n\n`;
      resposta += `✨ Posso te ajudar com **Neuropsicologia** ou outras terapias que temos:\n`;
      resposta += `• 💬 Fonoaudiologia\n• 🧠 Psicologia\n• 🏃 Fisioterapia\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n• 🎵 Musicoterapia\n\nQual te interessa?`;
    } else if (especialidade.includes('pediatra')) {
      resposta = `Entendi! Você tá buscando **pediatra** 👶\n\n`;
      resposta += `A gente é uma clínica de **terapias e reabilitação**, não atendemos com pediatras.\n\n`;
      resposta += `Mas temos **terapias infantis** como:\n`;
      resposta += `• 💬 Fonoaudiologia (fala, linguagem)\n• 🧠 Psicologia Infantil\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n\nAlguma te interessa?`;
    } else {
      resposta = `Entendi! Você tá buscando **${especialidade}** 🏥\n\n`;
      resposta += `Somos especializados em **terapias e reabilitação**. Não atendemos com médicos, mas temos:\n`;
      resposta += `• 💬 Fonoaudiologia\n• 🧠 Psicologia\n• 🏃 Fisioterapia\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n• 🧩 Neuropsicologia\n• 🎵 Musicoterapia\n\nAlguma te interessa?`;
    }

    return resposta;
  }

  /**
   * 📅 Mostra horários disponíveis
   */
  async mostrarHorarios(therapy, age, period) {
    try {
      this.logger.info('BOOKING', { therapy, age, period });

      const slots = await findAvailableSlots({
        therapyArea: therapy,
        preferredPeriod: period,
        patientAge: age
      });

      const info = THERAPY_DATA[therapy];

      if (slots?.primary?.length > 0) {
        const txt = slots.primary.slice(0, 3).map(s => `• ${s.day} às ${s.time}`).join('\n');
        return `Achei essas opções pra ${info?.name || therapy} ${info?.emoji}:\n\n${txt}\n\nQual desses funciona melhor? 😊\n\n(Se nenhum der certo, me avisa que busco outros!)`;
      }

      return `Poxa, não achei vagas pra ${info?.name || therapy} no período da ${period === 'manha' ? 'manhã' : period} agora 😔\n\nPosso:\n1️⃣ Ver outros períodos\n2️⃣ Pedir pra equipe te chamar quando abrir vaga\n\nQual prefere?`;

    } catch (e) {
      this.logger.error('BOOKING_ERROR', { error: e.message });
      return `Tô verificando os horários! ⏳\n\nEnquanto isso, me confirma: você prefere presencial ou online?`;
    }
  }

  // ==========================================================
  // 🔧 HELPERS LEGACY (mantidos para compatibilidade)
  // ==========================================================

  static async safeLeadUpdate(leadId, updateData, options = {}) {
    try {
      const result = await Leads.findByIdAndUpdate(leadId, updateData, { new: true, ...options });
      return result;
    } catch (err) {
      if (err.message?.includes("Cannot create field") && err.message?.includes("autoBookingContext")) {
        console.log("🔧 [SAFE-UPDATE] Inicializando autoBookingContext...");
        await Leads.findByIdAndUpdate(leadId, { $set: { autoBookingContext: {} } });
        try {
          const result = await Leads.findByIdAndUpdate(leadId, updateData, { new: true, ...options });
          return result;
        } catch (err2) {
          console.error("❌ [SAFE-UPDATE] Falhou mesmo após inicialização:", err2.message);
          return null;
        }
      }
      throw err;
    }
  }

  static mapComplaintToTherapyArea(complaint) {
    if (!complaint) return null;

    const detectedTherapies = detectAllTherapies(complaint);
    if (detectedTherapies?.length > 0) {
      const primary = detectedTherapies[0];
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
      return areaMap[primary.id] || null;
    }

    return null;
  }
}

export default WhatsAppOrchestrator;
