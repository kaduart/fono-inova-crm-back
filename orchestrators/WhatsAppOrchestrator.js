import Logger from '../services/utils/Logger.js';
import { findAvailableSlots } from '../services/amandaBookingService.js';
import Leads from '../models/Leads.js';
import ChatContext from '../models/ChatContext.js';
import { detectAllFlags } from '../utils/flagsDetector.js';
import { detectAllTherapies } from '../utils/therapyDetector.js';
import { buildResponse } from '../services/intelligence/naturalResponseBuilder.js';

// =============================================================================
// 🧠 ENTITY-BASED CONVERSATION ENGINE v6
// Matar o step-based, usar slot filling + extração preemptiva
// =============================================================================

/**
 * Extrai entidades de uma mensagem de forma inteligente e contextual
 * Não depende de "steps" - extrai o que encontrar, quando encontrar
 */
function extractEntities(text, context = {}) {
  if (!text || typeof text !== 'string') return {};
  
  const lowered = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const extracted = {};
  const words = text.trim().split(/\s+/);
  
  // ========================================================================
  // 1. EXTRAÇÃO DE IDADE (múltiplos padrões) - MOVIDO PARA PRIMEIRO
  // ========================================================================
  const idadePatterns = [
    /(\d+)\s*(anos?|a)/i,
    /(\d+)\s*anos?\s*de\s*idade/i,
    /tem\s*(\d+)\s*(anos?)?/i,
    /(\d+)\s*aninhos?/i,
    /(\d+)\s*meses?/i,
    /(\d+)[\s]*a/i  // "7 a" ou "7a"
  ];
  
  for (const pattern of idadePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const idade = parseInt(match[1]);
      if (idade >= 0 && idade <= 120) {
        extracted.age = idade;
        extracted.idadeRange = idade < 3 ? 'bebe' : 
                              idade < 12 ? 'crianca' : 
                              idade < 18 ? 'adolescente' : 'adulto';
        break;
      }
    }
  }
  
  // ========================================================================
  // 2. EXTRAÇÃO DE ESPECIALIDADE/TERAPIA
  // ========================================================================
  const especialidadeMap = {
    'psicologia': ['psicolog', 'psi ', 'terapia', 'terapeuta'],
    'fonoaudiologia': ['fono', 'fonoaudiolog', 'fala', 'linguagem', 'pronuncia'],
    'fisioterapia': ['fisio', 'fisioterapia', 'coluna', 'joelho', 'ombro'],
    'terapia_ocupacional': ['ocupacional', 'to ', 'terapia ocupacional', 'coordenacao motora'],
    'psicopedagogia': ['psicopedagog', 'psicopeda', 'aprendizado', 'escola', 'dificuldade de aprender'],
    'neuropsicologia': ['neuropsicolog', 'avaliacao neuro', 'funcoes cerebrais'],
    'musicoterapia': ['musicoterapia', 'musica', 'musicas']
  };
  
  for (const [key, keywords] of Object.entries(especialidadeMap)) {
    for (const keyword of keywords) {
      if (lowered.includes(keyword)) {
        extracted.therapy = key;
        break;
      }
    }
    if (extracted.therapy) break;
  }
  
  // ========================================================================
  // 3. EXTRAÇÃO DE INTENÇÃO (o usuário quer o quê agora?)
  // ========================================================================
  const intencaoPatterns = {
    'preco': /\b(valor|custa|pre[çc]o|preco|quanto|investimento|paga)\b/,
    'agendamento': /\b(agendar|marcar|consulta|vaga|horario|hora|disponibilidade|quando)\b/,
    'plano': /\b(plano|convenio|conv[eê]nio|saude|ipasgo|unimed|amil|reembolso)\b/,
    'endereco': /\b(onde|endere[çc]o|local|fica|chegar|localiza)/,
    'queixa': /\b(n[ãa]o fala|n[ãa]o forma|n[ãa]o consegue|fala pouco|fala pouca|atraso|atrasado|dificuldade|problema|preocupa|tdah|autismo|tantrum|desenvolvimento|atrasada|nao fala)\b/,
    'confirmacao': /\b(sim|quero|pode|claro|ok|tudo bem|vamos|top|beleza|combinado|perfeito|pode ser)\b/,
    'negacao': /\b(n[ãa]o|não quero|depois|outra hora|agora n[ãa]o|nao pode|impossivel)\b/
  };
  
  for (const [intencao, pattern] of Object.entries(intencaoPatterns)) {
    if (pattern.test(lowered)) {
      // Se for confirmação/negacao, marcar flags também
      if (intencao === 'confirmacao') extracted.isConfirmation = true;
      if (intencao === 'negacao') extracted.isNegation = true;
      
      // Intenção principal (preço tem prioridade sobre agendamento)
      if (!extracted.intencao || intencao === 'preco') {
        extracted.intencao = intencao;
      }
    }
  }
  
  // Se não detectou intenção específica, é informação geral
  if (!extracted.intencao) {
    extracted.intencao = 'informacao';
  }
  
  // ========================================================================
  // 4. TIPO DE PACIENTE (criança vs adulto)
  // ========================================================================
  const criancaIndicators = /\b(filho|filha|pequeno|pequena|crian[çc]a|bebe|beb[eê]|nene|nen[eê]|baby|filhinho|filhinha)\b/;
  const adultoIndicators = /\b(eu mesmo|pra mim|sou eu|adulto|marido|esposa|mae|pai)\b/;
  
  if (criancaIndicators.test(lowered)) {
    extracted.tipo_paciente = 'crianca';
  } else if (adultoIndicators.test(lowered)) {
    extracted.tipo_paciente = 'adulto';
  }
  
  // ========================================================================
  // 5. PERÍODO (manhã/tarde - SEM NOITE!)
  // ========================================================================
  if (/manh[ãa]|cedo|8h|9h|10h|11h|08|09|10|11/.test(lowered)) {
    extracted.period = 'manha';
  } else if (/tarde|14h|15h|16h|17h|14|15|16|17/.test(lowered)) {
    extracted.period = 'tarde';
  }
  // Ignora "noite" - não oferecemos!
  
  // ========================================================================
  // 6. QUEIXA/DESCRICAO (extrair se não for pergunta curta)
  // ========================================================================
  const isQuestion = /^(qual|quanto|onde|como|voce|voces|tem|faz|aceita|trabalha|pode)/i.test(text.trim());
  const isGreeting = /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|td bem)[\s!,.]*$/i.test(text.trim());
  
  // BUGFIX: Só extrai complaint se NÃO tiver intenção de ação já detectada
  const hasActionIntent = extracted.intencao && !['informacao', 'queixa'].includes(extracted.intencao);
  if (!isQuestion && !isGreeting && !hasActionIntent && text.length > 10 && !extracted.patientName && !extracted.age) {
    // Remove saudações e limpa
    let complaint = text.replace(/^(oi|ola|bom dia|boa tarde|boa noite)[,\s]*/i, '').substring(0, 250);
    // BUGFIX: Queixas podem ser curtas (ex: "voz", "fala pouco")
    if (complaint.length >= 5) {
      extracted.complaint = complaint;
    }
  }
  
  // ========================================================================
  // 7. EXTRAÇÃO DE NOME (heurística contextual) - MOVIDO PARA ÚLTIMO
  // ========================================================================
  // CRITICAL FIX: Só extrai nome se NÃO tiver detectado outras entidades relevantes
  // Isso evita extrair frases como "Aceita plano Unimed" como nome
  
  if (words.length >= 1 && words.length <= 3 && text.length > 1 && text.length <= 40) {
    const noiseWords = ['nao', 'não', 'sim', 'talvez', 'ok', 'blz', 'beleza', 'opa', 'oi', 'ola', 'tudo',
      'aceita', 'aceito', 'quero', 'queria', 'preciso', 'gostaria', 'pode', 'como', 'qual',
      'fono', 'fala', 'falar', 'ainda', 'pouco', 'muito', 'para', 'pra', 'meu', 'minha',
      'filho', 'filha', 'dele', 'dela', 'aqui', 'valor', 'quanto', 'custa', 'plano',
      'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada', 'tenho', 'tem',
      'não', 'nao', 'ele', 'ela', 'nos', 'nós', 'você', 'voce', 'vc'];
    
    const allWordsClean = words.map(w => w.toLowerCase().replace(/[^a-záàãâéêíóôõúç]/g, ''));
    const hasNoiseWord = allWordsClean.some(w => noiseWords.includes(w));
    
    // Só extrai como nome se:
    // 1. Nenhuma palavra é noise/verbo/preposição comum
    // 2. Não detectou outra entidade relevante nesta mensagem
    // 3. Parece nome próprio (não é frase comum)
    const hasOtherEntity = extracted.therapy || extracted.age || extracted.period || 
                           (extracted.intencao && extracted.intencao !== 'informacao');
    
    if (!hasNoiseWord && !hasOtherEntity && !text.match(/^\d+$/)) {
      const cleanedName = text.trim().replace(/[.,!?;:]$/, '');
      if (!cleanedName.toLowerCase().match(/^(nao|não|sim|na)$/)) {
        extracted.patientName = cleanedName;
      }
    }
  }
  
  return extracted;
}

/**
 * Slot Filling: determina quais entidades ainda estão faltando
 * Retorna array ordenado por prioridade de pergunta
 */
function getMissingEntities(context) {
  const required = [];
  
  // Ordem de prioridade para agendamento
  if (!context.therapy && !context.especialidade) {
    required.push({ field: 'therapy', question: 'specialty' });
  }
  
  if (!context.complaint && !context.queixa) {
    required.push({ field: 'complaint', question: 'complaint' });
  }
  
  if (!context.patientName && !context.nome) {
    required.push({ field: 'patientName', question: 'name' });
  }
  
  if (!context.age && !context.idade) {
    required.push({ field: 'age', question: 'age' });
  }
  
  if (!context.period && !context.horario) {
    required.push({ field: 'period', question: 'period' });
  }
  
  return required;
}

/**
 * Determina a próxima ação baseada no contexto + intenção atual
 * Substitui o step-based por decision-based
 */
function decideNextAction(context, extracted) {
  const missing = getMissingEntities(context);
  const intencao = extracted.intencao || context.lastIntencao || 'informacao';
  
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
  
  // Fluxo normal: preencher slots faltantes
  if (missing.length > 0) {
    return { 
      type: 'ASK_SLOT', 
      slot: missing[0].field,
      questionType: missing[0].question,
      missingCount: missing.length,
      nextMissing: missing[1] || null
    };
  }
  
  // Tudo preenchido, oferecer agendamento
  return { type: 'OFFER_AGENDAMENTO', missingAfter: [] };
}

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
    
    this.logger.info('V6_ENTITY_START', { leadId, text: text.substring(0, 80) });

    try {
      // 1. Carrega memória acumulada (contexto existente)
      const memory = await this.loadMemory(lead._id);
      
      // 2. EXTRAI ENTIDADES da mensagem atual (entity-based!)
      const extracted = extractEntities(text, memory);
      
      // 3. FUNDE (merge): acumula TUDO, nunca apaga
      // Agora usamos entities diretamente, mapeando campos antigos também
      const context = {
        ...memory,
        therapy: extracted.therapy || memory.therapy || null,
        complaint: extracted.complaint || memory.complaint || null,
        age: extracted.age || memory.age || null,
        period: extracted.period || memory.period || null,
        patientName: extracted.patientName || memory.patientName || null,
        tipo_paciente: extracted.tipo_paciente || memory.tipo_paciente || null,
        intencao: extracted.intencao || memory.intencao || null,
        // BUGFIX: isConfirmation/isNegation são POR MENSAGEM, não acumulativos
        isConfirmation: extracted.isConfirmation || false,
        isNegation: extracted.isNegation || false,
        flags: { ...memory.flags, ...(extracted.flags || {}) },
        // Metadados para tracking
        lastMessage: text,
        lastExtracted: Object.keys(extracted),
        messageCount: (memory.messageCount || 0) + 1
      };
      
      // 4. DECIDE A PRÓXIMA AÇÃO (entity-based, não step-based!)
      const action = decideNextAction(context, extracted);
      context.lastAction = action.type;
      context.lastIntencao = extracted.intencao;
      
      // Para compatibilidade, mantemos currentStep mas não dependemos dele
      const missing = getMissingEntities(context);
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
      
      // 5. Gera resposta baseada na ação decidida (não no step!)
      const response = await this.generateResponse(text, context, action, extracted);
      
      // 6. Persiste contexto atualizado
      await this.saveMemory(lead._id, context);
      
      this.logger.info('V6_ENTITY_COMPLETE', { leadId, action: action.type, responseLength: response?.length });
      return { command: 'SEND_MESSAGE', payload: { text: response } };
      
    } catch (error) {
      this.logger.error('V6_ENTITY_ERROR', { leadId, error: error.message, stack: error.stack });
      // Fallback humanizado
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
    // BUGFIX: Noite removido - clínica não atende à noite
    
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

  // 🎯 NOVO: Gera resposta baseada em ENTITIES + AÇÃO (não steps!)
  async generateResponse(text, ctx, action, extracted) {
    const { therapy, complaint, age, period, patientName, tipo_paciente, flags, isConfirmation, isNegation } = ctx;
    
    // ==========================================
    // 1. TRATAR INTERRUPÇÕES (preço, plano, endereço)
    // SEMPRE responde + retoma com pergunta
    // ==========================================
    if (flags?.asksPrice || action.type === 'RESPONSE_PRECO') {
      return this.responderInterrupcao(ctx, 'preco');
    }
    
    if (flags?.asksPlans || action.type === 'RESPONSE_PLANO') {
      return this.responderInterrupcao(ctx, 'plano');
    }
    
    if (flags?.asksAddress || action.type === 'RESPONSE_ENDERECO') {
      return this.responderInterrupcao(ctx, 'endereco');
    }
    
    // ==========================================
    // 2. FLUXO ENTITY-BASED (slot filling)
    // ==========================================
    
    // Se é primeira mensagem ou não temos nada
    if (action.type === 'ASK_SLOT') {
      return this.askForSlot(ctx, action.slot, action.questionType, extracted);
    }
    
    // BUGFIX: Código movido para dentro de askForSlot - reconhece entidade nova lá
    
    // Se tudo completo, oferece agendamento
    if (action.type === 'OFFER_AGENDAMENTO' || action.missingCount === 0) {
      if (isConfirmation) {
        return await this.mostrarHorarios(therapy, age, period);
      }
      if (isNegation) {
        return `Tudo bem! Sem problemas! 😊\n\nFico à disposição quando você quiser agendar. Qualquer dúvida, é só me chamar! Estou aqui para ajudar! 💚`;
      }
      
      const info = THERAPY_DATA[therapy];
      return `Maravilha! 🎉 Tenho todas as informações aqui:\n\n✅ ${info?.name || 'Consulta'}\n✅ Nome: ${patientName}\n✅ Idade: ${age} anos\n✅ Período: ${period === 'manha' ? 'manhã' : period}\n\nVou verificar os horários disponíveis agora, pode ser?`;
    }
    
    // Fallback humanizado
    return this.fallbackResponse(ctx);
  }
  
  // 🎭 Pergunta por um slot específico (com empatia!)
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
        // Só pergunta nome se não extraiu automaticamente
        if (!extracted?.patientName) {
          // HUMANIZADO: Consultora da clínica, não robô de formulário
          if (isCrianca) {
            return `E o pequeno, como se chama? 😊💚`;
          }
          return `E você, como posso te chamar? 💚`;
        }
        // Se extraiu mas ainda está no slot, valida de forma natural
        return `${extracted.patientName}, anotado! 🥰 E quantos anos ${extracted.patientName} tem?`;
        
      case 'age':
        // HUMANIZADO: Tom consultora, não formulário
        if (patientName) {
          return `${patientName} tem quantos anos? Assim eu consigo ver quais profissionais têm mais experiência com essa idade 😊`;
        }
        return `E a idade? Só pra eu verificar a disponibilidade certinha 💚`;
        
      case 'period':
        // HUMANIZADO: Período sem parecer burocracia
        return `Boa! E pra ${info?.name?.toLowerCase() || 'consulta'}, funciona melhor de manhã ou à tarde? ☀️\n\n(A gente atende das 8h às 18h, de segunda a sexta)`;
        
      default:
        return this.fallbackResponse(ctx);
    }
  }
  
  // ✅ Valida o que recebeu e pergunta o próximo
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
    
    // Fallback
    return this.fallbackResponse(ctx);
  }
  
  // 🆘 Resposta fallback humanizada
  fallbackResponse(ctx) {
    const { therapy, patientName } = ctx;
    
    if (!therapy) {
      return `Oi! Sou a Amanda da Fono Inova 💚 Que bom que entrou em contato! 😊\n\nMe conta: você está buscando atendimento para qual especialidade? (Fonoaudiologia, Psicologia, Fisioterapia...)`;
    }
    
    return `Entendi! 😊💚\n\nMe conta: qual é a principal questão que ${patientName || 'vocês'} ${patientName ? 'está' : 'estão'} enfrentando? Estou aqui para te ajudar!`;
  }

  // 🎯 LEGACY: mantido para compatibilidade (não usar em novo código)
  async conversar(text, ctx, step) {
    // Redireciona para o novo sistema entity-based
    const missing = getMissingEntities(ctx);
    const action = missing.length > 0 
      ? { type: 'ASK_SLOT', slot: missing[0].field, questionType: missing[0].question }
      : { type: 'OFFER_AGENDAMENTO', missingCount: 0 };
    
    const extracted = extractEntities(text, ctx);
    return this.generateResponse(text, ctx, action, extracted);
  }

  // 🔄 RESPOSTA DE INTERRUPÇÃO + RETOMADA OBRIGATÓRIA (entity-based)
  responderInterrupcao(ctx, tipo) {
    const { therapy, complaint, age, period, patientName } = ctx;
    
    let resposta = '';
    
    // Monta a resposta específica
    switch (tipo) {
      case 'preco':
        if (therapy) {
          const info = THERAPY_DATA[therapy];
          resposta = `Para ${info.name} ${info.emoji}:\n\n${info.valor}\n\nO investimento é de ${info.investimento} (${info.duracao}) 💚\n\nE o melhor: trabalhamos com reembolso de planos de saúde!`;
        } else {
          resposta = `Nossas avaliações são super completas! A gente entende exatamente a necessidade e traça um plano personalizado 💚\n\n💬 Fonoaudiologia: R$ 200\n🧠 Psicologia: R$ 200\n🏃 Fisioterapia: R$ 200\n📚 Psicopedagogia: R$ 200\n🎵 Musicoterapia: R$ 180\n🤸 Psicomotricidade: R$ 180\n🧩 Neuropsicologia: R$ 400\n\nOs valores de tratamento são discutidos após a avaliação! 😊\n\nE trabalhamos com reembolso de planos!`;
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
    
    // 🎯 RETOMADA INTELIGENTE: pergunta o que falta (entity-based!)
    const missing = getMissingEntities(ctx);
    let perguntaRetomada = '';
    
    if (missing.length === 0) {
      // Tem tudo, oferece agendamento
      perguntaRetomada = `\n\nVou verificar os horários disponíveis! Posso buscar para você?`;
    } else {
      // Pergunta o próximo slot faltante
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
      // BUGFIX: Removido 'noite' - clínica não atende à noite
      return `No momento não encontrei vagas para ${info?.name || therapy} no período da ${period === 'manha' ? 'manhã' : period}. 😔\n\nPosso:\n1️⃣ Verificar outros períodos (manhã ou tarde)\n2️⃣ Pedir para nossa equipe entrar em contato quando tiver vaga\n\nO que prefere?`;
      
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
