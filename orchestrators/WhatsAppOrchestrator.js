import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import { detectAllFlags } from '../utils/flagsDetector.js';
import { detectAllTherapies } from '../utils/therapyDetector.js';

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

    this.logger.info('V6_ENTITY_START', { leadId, text: text.substring(0, 80) });

    try {
      // 1. 🔄 CARREGA CONTEXTO DO BANCO (novo sistema)
      const memory = await loadContext(leadId);
      
      // 2. 🔍 EXTRAI ENTIDADES (novo sistema robusto)
      const extracted = extractEntities(text, memory);
      
      // 3. 🧠 MERGE INTELIGENTE (preserva dados válidos)
      const context = mergeContext(memory, extracted);
      
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

    // 🔧 FIX BUG #1: Detectar especialidades NÃO atendidas
    const text = extracted.rawText || originalText || '';
    const textLower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const ESPECIALIDADES_NAO_ATENDIDAS = [
      'neurologista', 'neurologia', 'neurologo',
      'pediatra', 'pediatria',
      'cardiologista', 'cardiologia',
      'ortopedista', 'ortopedia',
      'dermatologista', 'dermatologia'
    ];

    for (const esp of ESPECIALIDADES_NAO_ATENDIDAS) {
      if (textLower.includes(esp)) {
        return { type: 'RESPONSE_TERAPIA_NAO_ATENDIDA', especialidade: esp, missingAfter: missing };
      }
    }

    // Se usuário mudou de assunto (intenção clara), responder isso primeiro
    if (intencao === 'preco' && context.therapy) {
      return { type: 'RESPONSE_PRECO', missingAfter: missing };
    }

    if (intencao === 'plano') {
      return { type: 'RESPONSE_PLANO', missingAfter: missing };
    }

    if (intencao === 'endereco') {
      return { type: 'RESPONSE_ENDERECO', missingAfter: missing };
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

      // 🔧 FIX BUG #2: SEMPRE busca horários quando contexto está completo
      // Antes: só buscava se ctx.isConfirmation, agora busca sempre
      if (therapy && age && period) {
        this.logger.info('OFFER_AGENDAMENTO_EXECUTANDO_BUSCA', { therapy, age, period });
        return await this.mostrarHorarios(therapy, age, period);
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
        return `Oi! Sou a Amanda da Fono Inova! 😊💚\n\nQue bom que você entrou em contato! Já vi que você está buscando ajuda, e isso é um passo muito importante! 👏\n\nMe conta: você está buscando atendimento para fonoaudiologia, psicologia, ou qual especialidade?`;

      case 'complaint':
        if (therapy === 'fonoaudiologia') {
          return `Entendi que é para fonoaudiologia! 💬\n\nMe conta um pouquinho mais sobre a situação: o pequeno ainda não fala nada, fala algumas palavrinhas, ou tem alguma dificuldade específica que você notou? Estou aqui para te ouvir! 💚`;
        }
        if (therapy === 'psicologia') {
          return isCrianca
            ? `Sobre psicologia para crianças 🧠💚\n\nMe conta como está a situação do pequeno... Está com dificuldade de atenção na escola, comportamento, ou algo mais que está te preocupando? Pode desabafar!`
            : `Sobre psicologia 🧠💚\n\nMe conta como você está se sentindo ultimamente... Está com ansiedade, dificuldade para dormir, ou tem algo mais que está te incomodando? Estou aqui para ouvir!`;
        }
        return `Perfeito! ${info?.emoji || '💚'}\n\nMe conta um pouco mais sobre a situação que está preocupando. Quero entender direitinho para poder ajudar da melhor forma!`;

      case 'patientName':
        if (!extracted?.patientName) {
          const sujeito = isCrianca ? 'o pequeno' : (therapy === 'psicologia' ? 'a criança' : 'o paciente');
          return `Para eu organizar tudo certinho aqui, me conta: como é o nome de ${sujeito}? 💚`;
        }
        return `Que nome lindo, ${extracted.patientName}! 🥰💚\n\nE quantos anos ${extracted.patientName} tem?`;

      case 'age':
        if (patientName) {
          return `Que nome lindo, ${patientName}! 🥰\n\nE quantos anos ${patientName} tem? Isso ajuda a verificar quais profissionais têm mais experiência com essa idade! 💚`;
        }
        return `Só para eu verificar a disponibilidade certinha... Quantos anos ${isCrianca ? 'o pequeno' : 'você'} tem? 💚`;

      case 'period':
        return `Perfeito! 🌟\n\nPara ${info?.name?.toLowerCase() || 'o atendimento'}, temos ótimos profissionais. Qual período funciona melhor para vocês: **manhã ou tarde**? (Nosso horário é das 8h às 18h) ☀️`;

      default:
        return this.fallbackResponse(ctx);
    }
  }

  /**
   * ✅ Valida o que recebeu e pergunta o próximo
   */
  acknowledgeAndAskNext(ctx, receivedField, extracted) {
    const { therapy, patientName, age, period, tipo_paciente } = ctx;
    const info = therapy ? THERAPY_DATA[therapy] : null;
    const isCrianca = tipo_paciente === 'crianca' || (age && age < 12);

    // Recebemos NOME → pergunta IDADE
    if (receivedField === 'name' && patientName) {
      return `Que nome lindo, ${patientName}! 🥰💚\n\nE quantos anos ${patientName} tem? Isso ajuda a verificar quais profissionais têm mais experiência com essa idade!`;
    }

    // Recebemos IDADE → pergunta PERÍODO
    if (receivedField === 'age' && age) {
      let acolhimento = '';
      if (age <= 3) acolhimento = `Que fofa! ${age} aninhos é uma fase tão especial! 🥰💚`;
      else if (age <= 12) acolhimento = `${age} anos! Uma idade linda para acompanhar o desenvolvimento! 🌟`;
      else if (age <= 17) acolhimento = `Adolescência é uma fase de muitas transformações, né? 💚`;
      else acolhimento = `Perfeito! Vamos cuidar muito bem de você! 💚`;

      return `${acolhimento}\n\nPara ${info?.name?.toLowerCase() || 'o atendimento'}, temos ótimos profissionais. Qual período funciona melhor para vocês: **manhã ou tarde**? (Nosso horário é das 8h às 18h) ☀️`;
    }

    // Recebemos PERÍODO → oferece agendamento
    if (receivedField === 'period' && period) {
      const periodoTexto = period === 'manha' ? 'manhã' : period;
      return `Perfeito! Anotado ${periodoTexto}! ✅\n\nDeixa eu verificar os horários disponíveis para você... Só um instante! ⏳`;
    }

    return this.fallbackResponse(ctx);
  }

  /**
   * 🆘 Resposta fallback
   */
  fallbackResponse(ctx) {
    const { therapy, patientName } = ctx;

    if (!therapy) {
      return `Oi! Sou a Amanda da Fono Inova 💚 Que bom que entrou em contato! 😊\n\nMe conta: você está buscando atendimento para qual especialidade? (Fonoaudiologia, Psicologia, Fisioterapia...)`;
    }

    return `Entendi! 😊💚\n\nMe conta: qual é a principal questão que ${patientName || 'vocês'} ${patientName ? 'está' : 'estão'} enfrentando? Estou aqui para te ajudar!`;
  }

  /**
   * ✨ Resposta para pergunta sobre disponibilidade
   * Responde SIM/NÃO e então pergunta sobre a queixa
   */
  responderDisponibilidade(ctx) {
    const { therapy, tipo_paciente } = ctx;
    const info = therapy ? THERAPY_DATA[therapy] : null;

    if (!info) {
      return `Oi! Sou a Amanda da Fono Inova! 😊💚\n\nQue bom que você entrou em contato! Trabalhamos com diversas especialidades. Me conta: qual atendimento você está procurando?`;
    }

    const isCrianca = tipo_paciente === 'crianca';

    // Confirma que tem a especialidade
    let resposta = `Sim, temos ${info.name}! ${info.emoji} ${info.acolhimento}\n\n`;

    // Pergunta sobre a queixa/situação
    if (therapy === 'fonoaudiologia') {
      resposta += `Me conta um pouquinho mais sobre a situação: o pequeno ainda não fala nada, fala algumas palavrinhas, ou tem alguma dificuldade específica que você notou? Estou aqui para te ouvir! 💚`;
    } else if (therapy === 'psicologia') {
      if (isCrianca) {
        resposta += `Me conta como está a situação da criança... Está com dificuldade de atenção, comportamento, ou algo que está te preocupando? Pode desabafar! 💚`;
      } else {
        resposta += `Me conta como você está se sentindo ultimamente... Está com ansiedade, dificuldade para dormir, ou tem algo que está te incomodando? Estou aqui para ouvir! 💚`;
      }
    } else if (therapy === 'fisioterapia') {
      resposta += `Me conta um pouco sobre o que está sentindo... É dor na coluna, no joelho, ou algum desconforto específico? Vamos entender direitinho para poder ajudar! 💚`;
    } else {
      resposta += `Me conta um pouco mais sobre a situação que está preocupando. Quero entender direitinho para poder ajudar da melhor forma! 💚`;
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
          resposta = `Para ${info.name} ${info.emoji}:\n\n${info.valor}\n\nO investimento é de ${info.investimento} (${info.duracao}) 💚\n\nE o melhor: trabalhamos com reembolso de planos de saúde!`;
        } else {
          resposta = `Nossas avaliações são super completas! A gente entende exatamente a necessidade e traça um plano personalizado 💚\n\n💬 Fonoaudiologia: R$ 200\n🧠 Psicologia: R$ 200\n🏃 Fisioterapia: R$ 200\n📚 Psicopedagogia: R$ 200\n🎵 Musicoterapia: R$ 180\n🧩 Neuropsicologia: R$ 400\n\nE trabalhamos com reembolso de planos!`;
        }
        break;

      case 'plano':
        resposta = `💚 Trabalhamos com reembolso de todos os planos de saúde! Você paga e solicita o ressarcimento (geralmente entre 80% e 100% do valor). Também aceitamos Pix, cartão de crédito e débito! 😊`;
        break;

      case 'endereco':
        resposta = `📍 Ficamos na Av. Brasil, 1234 - Centro de Anápolis/GO. Temos estacionamento fácil na rua e também estacionamento pago bem próximo! 🚗`;
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
   * 🚫 Resposta para especialidades que NÃO atendemos
   */
  responderEspecialidadeNaoAtendida(especialidade, ctx) {
    const missing = getMissingSlots(ctx);

    let resposta = '';

    // Respostas específicas por especialidade
    if (especialidade.includes('neurolog')) {
      resposta = `Entendo que você está buscando um **neurologista** 🧠\n\n`;
      resposta += `Na Fono Inova trabalhamos com **Neuropsicologia** (avaliação das funções cerebrais como atenção, memória, raciocínio), `;
      resposta += `mas para acompanhamento neurológico médico, você precisará consultar um neurologista clínico.\n\n`;
      resposta += `✨ Posso ajudar com **Neuropsicologia** ou outras terapias que temos disponíveis:\n`;
      resposta += `• 💬 Fonoaudiologia\n• 🧠 Psicologia\n• 🏃 Fisioterapia\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n• 🎵 Musicoterapia\n\nQual delas te interessa? 💚`;
    } else if (especialidade.includes('pediatra')) {
      resposta = `Entendo! Você está buscando um **pediatra** 👶\n\n`;
      resposta += `Nós somos uma clínica de **terapias e reabilitação**, não atendemos com pediatras.\n\n`;
      resposta += `Mas temos **terapias infantis** maravilhosas como:\n`;
      resposta += `• 💬 Fonoaudiologia (fala, linguagem)\n• 🧠 Psicologia Infantil\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n\nAlguma delas te interessa? 💚`;
    } else {
      resposta = `Entendo! Você está buscando **${especialidade}** 🏥\n\n`;
      resposta += `Somos especializados em **terapias e reabilitação**. Não atendemos com médicos, mas temos:\n`;
      resposta += `• 💬 Fonoaudiologia\n• 🧠 Psicologia\n• 🏃 Fisioterapia\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n• 🧩 Neuropsicologia\n• 🎵 Musicoterapia\n\nAlguma dessas especialidades te interessa? 💚`;
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
        return `Encontrei essas opções para ${info?.name || therapy} ${info?.emoji}:\n\n${txt}\n\nQual desses horários funciona melhor para você? 💚\n\n(Se não der certo nenhum, me avisa que busco outras opções!)`;
      }

      return `No momento não encontrei vagas para ${info?.name || therapy} no período da ${period === 'manha' ? 'manhã' : period}. 😔\n\nPosso:\n1️⃣ Verificar outros períodos (manhã/tarde)\n2️⃣ Pedir para nossa equipe entrar em contato quando tiver vaga\n\nO que prefere?`;

    } catch (e) {
      this.logger.error('BOOKING_ERROR', { error: e.message });
      return `Estou verificando os horários disponíveis! ⏳\n\nEnquanto isso, me confirma: você prefere atendimento presencial ou online? 💚`;
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
