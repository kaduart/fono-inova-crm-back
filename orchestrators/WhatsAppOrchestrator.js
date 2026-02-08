import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import ChatContext from '../models/ChatContext.js';
import { detectAllFlags } from '../utils/flagsDetector.js';
import { detectAllTherapies } from '../utils/therapyDetector.js';
import { buildResponse } from '../services/intelligence/naturalResponseBuilder.js';

// Dados das terapias - VALOR ANTES DO PREÇO! 🎯
const THERAPY_DATA = {
  fonoaudiologia: { 
    name: 'Fonoaudiologia', 
    emoji: '💬',
    // VALOR primeiro: o que resolve, depois o investimento
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
  },
  psicomotricidade: { 
    name: 'Psicomotricidade', 
    emoji: '🤸', 
    avaliacao: 'Avaliação: R$ 180 (50 minutos)',
    acolhimento: 'O movimento é vida! 🤸💚'
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

// 🎯 ESTADOS DO FUNIL (sempre avança, nunca quebra)
const FLOW_STEPS = {
  SAUDACAO: 'saudacao',           // Primeiro contato - acolhimento
  NOME: 'nome',                   // Nome do paciente (NOVO!)
  QUEIXA: 'queixa',               // Entender a dor/situação
  IDADE: 'idade',                 // Idade do paciente
  DISPONIBILIDADE: 'disponibilidade', // Período do dia (SEM NOITE!)
  AGENDAMENTO: 'agendamento',     // Oferecer horários
  CONFIRMACAO: 'confirmacao'      // Confirmar/aguardar resposta
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
      
      // 4. Determina em qual passo do funil estamos
      const currentStep = this.determinarStep(context);
      context.currentStep = currentStep;
      
      this.logger.info('V5_CONTEXT', { 
        leadId, 
        therapy: context.therapy, 
        age: context.age, 
        period: context.period,
        step: currentStep 
      });
      
      // 5. Conversa fluida com acolhimento + pergunta obrigatória
      const response = await this.conversar(text, context, currentStep);
      
      // 6. Persiste
      await this.saveMemory(lead._id, context);
      
      this.logger.info('V5_COMPLETE', { leadId, responseLength: response?.length });
      return { command: 'SEND_MESSAGE', payload: { text: response } };
      
    } catch (error) {
      this.logger.error('V5_ERROR', { leadId, error: error.message });
      // Fallback sempre com pergunta!
      return { 
        command: 'SEND_MESSAGE', 
        payload: { text: 'Oi! Sou a Amanda da Fono Inova 💚 Que bom que entrou em contato! 😊\n\nMe conta: é para você ou para um pequeno? Qual situação vocês estão enfrentando?' } 
      };
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
    
    // Data de nascimento (DD/MM/AAAA ou similar)
    const birthDateMatch = text.match(/(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/);
    const birthDate = birthDateMatch ? `${birthDateMatch[1]}/${birthDateMatch[2]}/${birthDateMatch[3]}` : null;
    
    let period = null;
    if (/manh[ãa]|cedo/i.test(lower)) period = 'manha';
    else if (/tarde/i.test(lower)) period = 'tarde';
    else if (/noite/i.test(lower)) period = 'noite';
    
    // Detectar nome
    const namePatterns = [
      /meu nome [ée]\s+([A-Za-z\s]{2,30})/i,
      /nome [ée]\s+([A-Za-z\s]{2,30})/i,
      /chamo\s+([A-Za-z\s]{2,30})/i,
      /([A-Za-z]{2,20})\s+tem\s+\d+/i,  // "João tem 5 anos"
      /a\s+([A-Za-z]{2,20})\s+tem/i       // "a Maria tem"
    ];
    
    let patientName = null;
    for (const pattern of namePatterns) {
      const match = text.match(pattern);
      if (match) {
        patientName = match[1].trim();
        break;
      }
    }
    
    // Queixa (se não for pergunta direta)
    const isQuestion = /^(qual|quanto|onde|como|voce|voces|tem|faz|aceita|trabalha)/i.test(text.trim());
    const isGreeting = /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|td bem|oi tudo bem)[\s!,.]*$/i.test(text.trim());
    
    let complaint = null;
    if (!isQuestion && !isGreeting && text.length > 5) {
      // Remove saudações do início
      complaint = text.replace(/^(oi|ola|bom dia|boa tarde|boa noite)[,\s]*/i, '').substring(0, 200);
    }
    
    // Detectar confirmação positiva (sim, quero, pode ser, etc)
    const isConfirmation = /\b(sim|quero|pode|claro|ok|tudo bem|vamos|top|beleza|combinado|perfeito)\b/i.test(lower);
    const isNegation = /\b(n[ãa]o|não quero|depois|outra hora)\b/i.test(lower);
    
    return { 
      therapy, 
      flags, 
      age, 
      birthDate,
      period, 
      complaint,
      patientName,
      isConfirmation,
      isNegation
    };
  }

  // FUNDE: acumula, nunca apaga (só sobrescreve se veio novo)
  fundir(old, detected) {
    return {
      therapy: detected.therapy || old.therapy || null,
      complaint: detected.complaint || old.complaint || null,
      age: detected.age || old.age || null,
      birthDate: detected.birthDate || old.birthDate || null,
      period: detected.period || old.period || null,
      patientName: detected.patientName || old.patientName || null,
      flags: { ...old.flags, ...detected.flags },
      isConfirmation: detected.isConfirmation || old.isConfirmation || false,
      isNegation: detected.isNegation || old.isNegation || false
    };
  }

  // Determina em qual passo do funil estamos
  determinarStep(ctx) {
    const { therapy, complaint, age, period, patientName } = ctx;
    
    // Se não tem terapia nem queixa, está na saudação
    if (!therapy && !complaint) {
      return FLOW_STEPS.SAUDACAO;
    }
    
    // Se tem terapia mas não tem queixa detalhada, está na queixa
    if (therapy && !complaint) {
      return FLOW_STEPS.QUEIXA;
    }
    
    // Se tem terapia e queixa mas não tem nome, pergunta nome primeiro
    if (therapy && complaint && !patientName) {
      return FLOW_STEPS.NOME;
    }
    
    // Se tem nome mas não tem idade, pergunta idade
    if (therapy && complaint && patientName && !age) {
      return FLOW_STEPS.IDADE;
    }
    
    // Se tem idade mas não tem período, pergunta período
    if (therapy && complaint && patientName && age && !period) {
      return FLOW_STEPS.DISPONIBILIDADE;
    }
    
    // Se tem tudo, está no agendamento
    if (therapy && complaint && patientName && age && period) {
      return FLOW_STEPS.AGENDAMENTO;
    }
    
    return FLOW_STEPS.SAUDACAO;
  }

  // 🎯 LÓGICA DE CONVERSA COM ACOLHIMENTO + PERGUNTA OBRIGATÓRIA
  async conversar(text, ctx, step) {
    const { therapy, complaint, age, period, patientName, flags, isConfirmation, isNegation } = ctx;
    
    // ==========================================
    // TRATAR INTERRUPÇÕES (preço, plano, endereço)
    // SEMPRE responde + retoma com pergunta
    // ==========================================
    if (flags.asksPrice) {
      return this.responderInterrupcao(ctx, 'preco');
    }
    
    if (flags.asksPlans) {
      return this.responderInterrupcao(ctx, 'plano');
    }
    
    if (flags.asksAddress) {
      return this.responderInterrupcao(ctx, 'endereco');
    }
    
    if (flags.asksSchedule && !therapy) {
      return this.responderInterrupcao(ctx, 'agendamento_sem_terapia');
    }
    
    // ==========================================
    // FLUXO PRINCIPAL DO FUNIL
    // ==========================================
    
    // PASSO 1: SAUDAÇÃO (primeiro contato com ACOLHIMENTO REAL)
    if (step === FLOW_STEPS.SAUDACAO) {
      // Se o usuário já veio com terapia na primeira mensagem
      if (therapy) {
        const info = THERAPY_DATA[therapy];
        return `Oi! 😊 Que bom que você entrou em contato! 💚\n\n${info.acolhimento}\n\nMe conta: o que está acontecendo que te trouxe até aqui hoje? Estou aqui para te ouvir!`;
      }
      
      // Saudação padrão acolhedora
      return `Oi! Sou a Amanda da Fono Inova! 😊💚\n\nQue bom que você entrou em contato! Já vi que você está buscando ajuda, e isso é um passo muito importante! 👏\n\nMe conta: é para você ou para um pequeno da família? E o que está acontecendo que te preocupa?`;
    }
    
    // PASSO 2: QUEIXA (entender a dor com EMPATIA)
    if (step === FLOW_STEPS.QUEIXA) {
      const info = THERAPY_DATA[therapy];
      
      // Se veio queixa na mensagem atual
      if (complaint) {
        // Validação empática do que entendeu
        let validacao = '';
        if (therapy === 'fonoaudiologia') {
          validacao = `Ah, entendi! 💬 Então é sobre a comunicação. Deve ser preocupante ver essa dificuldade, né? Mas fica tranquila, a gente consegue ajudar muito! 🥰`;
        } else if (therapy === 'psicologia') {
          validacao = `Compreendo! 🧠 Cuidar da saúde mental é fundamental. Você está fazendo o certo em buscar apoio! 💚`;
        } else {
          validacao = `Entendido! ${info.emoji} Vamos cuidar disso com muito carinho! 💚`;
        }
        
        return `${validacao}\n\nPara eu organizar tudo certinho aqui, me conta: como é o nome do pequeno?`;
      }
      
      // Ainda não entendeu a queixa - perguntar com mais calor
      if (therapy === 'fonoaudiologia') {
        return `Entendi que é para fonoaudiologia! 💬\n\nMe conta um pouquinho mais sobre ele: ele ainda não fala nada, fala algumas palavrinhas, ou tem alguma dificuldade específica que você notou? Estou aqui para te ouvir! 💚`;
      }
      
      if (therapy === 'psicologia') {
        return `Sobre psicologia 🧠💚\n\nMe conta como você está se sentindo ultimamente... Está com ansiedade, dificuldade para dormir, ou tem algo mais que está te incomodando? Pode desabafar!`;
      }
      
      return `Perfeito! ${info.emoji}\n\nMe conta um pouco mais sobre a situação que está preocupando você. Quero entender direitinho para poder ajudar da melhor forma! 💚`;
    }
    
    // PASSO NOVO: NOME (perguntar nome antes da idade!)
    if (step === FLOW_STEPS.NOME) {
      const info = THERAPY_DATA[therapy];
      
      // Se acabou de dar nome
      if (patientName) {
        return `Que nome lindo, ${patientName}! 🥰💚\n\nE quantos anos ${patientName} tem? Isso ajuda a verificar quais profissionais têm mais experiência com essa idade!`;
      }
      
      // Perguntar nome de forma acolhedora
      return `Para eu organizar tudo certinho aqui, me conta: como é o nome ${therapy === 'psicologia' ? 'da criança' : 'dele/de'}? 💚`;
    }
    
    // PASSO NOVO: IDADE (só pergunta idade depois do nome)
    if (step === FLOW_STEPS.IDADE) {
      // Se acabou de dar idade
      if (age) {
        let acolhimentoIdade = '';
        if (age <= 3) {
          acolhimentoIdade = `Que fofa! ${age} aninhos é uma fase tão especial! 🥰💚`;
        } else if (age <= 12) {
          acolhimentoIdade = `${age} anos! Uma idade linda para acompanhar o desenvolvimento! 🌟`;
        } else if (age <= 17) {
          acolhimentoIdade = `Adolescência é uma fase de muitas transformações, né? 💚`;
        } else {
          acolhimentoIdade = `Perfeito! Vamos cuidar muito bem de você! 💚`;
        }
        
        const info = THERAPY_DATA[therapy];
        return `${acolhimentoIdade}\n\nPara ${info.name.toLowerCase()}, temos ótimos profissionais. Qual período funciona melhor para vocês: **manhã ou tarde**? (Nosso horário de atendimento é das 8h às 18h) ☀️`;
      }
      
      // Insistir na idade de forma gentil
      return `Só para eu verificar a disponibilidade certinha... Quantos anos ${patientName} tem? 💚`;
    }
    
    // PASSO: DISPONIBILIDADE (período - SEM NOITE!)
    if (step === FLOW_STEPS.DISPONIBILIDADE) {
      // Se acabou de dar período
      if (period) {
        const periodoTexto = period === 'manha' ? 'manhã' : period;
        return `Perfeito! Anotado ${periodoTexto}! ✅\n\nDeixa eu verificar os horários disponíveis para você... Só um instante! ⏳`;
      }
      
      // IMPORTANTE: Não oferecer noite se não atende!
      return `Qual período funciona melhor para vocês: **manhã ou tarde**? ☀️\n\n(Nosso horário de atendimento é de segunda a sexta, das 8h às 18h)`;
    }
    
    // PASSO: AGENDAMENTO (mostrar horários)
    if (step === FLOW_STEPS.AGENDAMENTO) {
      // Se usuário confirmou "sim" ou demonstrou interesse
      if (isConfirmation) {
        return await this.mostrarHorarios(therapy, age, period);
      }
      
      // Se usuário disse não
      if (isNegation) {
        return `Tudo bem! Sem problemas! 😊\n\nFico à disposição quando você quiser agendar. Qualquer dúvida, é só me chamar! Estou aqui para ajudar! 💚`;
      }
      
      // Tudo pronto, oferecer agendamento
      const info = THERAPY_DATA[therapy];
      return `Maravilha! 🎉 Tenho todas as informações aqui:\n\n✅ ${info.name}\n✅ Nome: ${patientName}\n✅ Idade: ${age} anos\n✅ Período: ${period === 'manha' ? 'manhã' : period}\n\nVou verificar os horários disponíveis agora, pode ser?`;
    }
    
    // Fallback: sempre com pergunta!
    return `Entendi! 😊💚\n\nMe conta: qual é a principal questão que vocês estão enfrentando? Estou aqui para te ajudar!`;
  }

  // 🔄 RESPOSTA DE INTERRUPÇÃO + RETOMADA OBRIGATÓRIA
  responderInterrupcao(ctx, tipo) {
    const { therapy, complaint, age, period, patientName } = ctx;
    
    let resposta = '';
    let perguntaRetomada = '';
    
    // Monta a resposta específica
    switch (tipo) {
      case 'preco':
        if (therapy) {
          const info = THERAPY_DATA[therapy];
          resposta = `Para ${info.name} ${info.emoji}:\n\n${info.valor}\n\nO investimento é de ${info.investimento} (${info.duracao}) 💚\n\nE o melhor: trabalhamos com reembolso de planos de saúde!`;
        } else {
          resposta = `Nossas avaliações são super completas! A gente entende exatamente a necessidade e traça um plano personalizado 💚\n\n💬 Fonoaudiologia: R$ 200\n🧠 Psicologia: R$ 200\n🏃 Fisioterapia: R$ 200\n📚 Psicopedagogia: R$ 200\n🎵 Musicoterapia: R$ 180\n🤸 Psicomotricidade: R$ 180\n🧩 Neuropsicologia: R$ 400\n\nOs valores de tratamento são discutidos após a avaliação, quando já soubermos o que é necessário! 😊\n\nE trabalhamos com reembolso de planos!`;
        }
        break;
        
      case 'plano':
        resposta = `💚 Trabalhamos com reembolso de todos os planos de saúde! Você paga e solicita o ressarcimento (geralmente entre 80% e 100% do valor). Também aceitamos Pix, cartão de crédito e débito! 😊`;
        break;
        
      case 'endereco':
        resposta = `📍 Ficamos na Av. Brasil, 1234 - Centro de Anápolis/GO. Temos estacionamento fácil na rua e também estacionamento pago bem próximo! 🚗`;
        break;
        
      case 'agendamento_sem_terapia':
        resposta = `Claro! Podemos agendar sim! 😊`;
        break;
    }
    
    // Determina qual pergunta fazer para retomar o fluxo
    if (!therapy) {
      perguntaRetomada = `\n\nE me conta: você está buscando atendimento para fonoaudiologia, psicologia, ou qual especialidade?`;
    } else if (!complaint) {
      const info = THERAPY_DATA[therapy];
      perguntaRetomada = `\n\nPara ${info.name.toLowerCase()}, me conta um pouco sobre a situação que está preocupando?`;
    } else if (!age) {
      perguntaRetomada = `\n\nE qual a idade${patientName ? ` de ${patientName}` : ''}? Para eu verificar os melhores profissionais disponíveis!`;
    } else if (!period) {
      // IMPORTANTE: Não oferecer "noite" se a clínica não atende!
      perguntaRetomada = `\n\nQual período funciona melhor para vocês: **manhã ou tarde**? (Nosso horário é das 8h às 18h)`;
    } else {
      perguntaRetomada = `\n\nVou verificar os horários disponíveis! Posso buscar para você?`;
    }
    
    return resposta + perguntaRetomada;
  }

  // 🎯 MOSTRAR HORÁRIOS (agora com await correto!)
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
      
      // Sem vagas no período desejado
      return `No momento não encontrei vagas para ${info?.name || therapy} no período da ${period === 'manha' ? 'manhã' : period}. 😔\n\nPosso:\n1️⃣ Verificar outros períodos (manhã/tarde/noite)\n2️⃣ Pedir para nossa equipe entrar em contato quando tiver vaga\n\nO que prefere?`;
      
    } catch (e) {
      this.logger.error('BOOKING_ERROR', { error: e.message });
      return `Estou verificando os horários disponíveis! ⏳\n\nEnquanto isso, me confirma: você prefere atendimento presencial ou online? 💚`;
    }
  }

  async loadMemory(leadId) {
    try {
      const ctx = await ChatContext.findOne({ lead: leadId }).lean();
      return ctx?.conversationState || { 
        therapy: null, 
        complaint: null, 
        age: null, 
        period: null, 
        patientName: null,
        flags: {} 
      };
    } catch (e) {
      return { 
        therapy: null, 
        complaint: null, 
        age: null, 
        period: null, 
        patientName: null,
        flags: {} 
      };
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

  // ==========================================================
  // 🔧 HELPERS ÚTEIS (migrados do amandaOrchestrator antigo)
  // ==========================================================

  /**
   * 🛡️ Update seguro que inicializa autoBookingContext se for null
   * Evita erros de "Cannot create field" no MongoDB
   */
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
          console.log("✅ [SAFE-UPDATE] Bem-sucedido após inicialização");
          return result;
        } catch (err2) {
          console.error("❌ [SAFE-UPDATE] Falhou mesmo após inicialização:", err2.message);
          return null;
        }
      }
      throw err;
    }
  }

  /**
   * 🎯 Mapeia queixa para área terapêutica
   */
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

  /**
   * 📝 Log de erro suprimido (não crítico)
   */
  static logSuppressedError(context, err) {
    console.warn(`[AMANDA-SUPPRESSED] ${context}:`, {
      message: err.message,
      stack: err.stack?.split('\n')[1]?.trim(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 🎨 Gera pergunta com variação natural (usando naturalResponseBuilder)
   */
  static generateNaturalQuestion(intent, context = {}) {
    try {
      const response = buildResponse(intent, context);
      if (response && response !== 'Como posso ajudar? 💚') {
        return response;
      }
    } catch (e) {
      // Fallback silencioso
    }
    return null;
  }
}

export default WhatsAppOrchestrator;
