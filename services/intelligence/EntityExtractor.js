/**
 * 🔍 EntityExtractor - Extração robusta de entidades
 * Versão 2.1 - Desengessada com escape hatch e scoring
 */

import { isValidName, cleanName, isValidAge, checkExplicitName } from './EntityValidator.js';

// Mapas de referência
const THERAPY_KEYWORDS = {
  'psicologia': ['psicolog', 'psi ', 'psicólogo', 'psicóloga', 'terapia', 'ansiedade', 'depressão', 'tdah', 'autismo', 'tea'],
  'fonoaudiologia': ['fono', 'fonoaudiolog', 'fala', 'linguagem', 'pronuncia', 'gagueira', 'atraso de fala', 'não fala'],
  'fisioterapia': ['fisio', 'fisioterapia', 'coluna', 'joelho', 'ombro', 'postura', 'reabilitação'],
  'terapia_ocupacional': ['ocupacional', 'to ', 'terapia ocupacional', 'coordenação motora', 'sensorial'],
  'psicopedagogia': ['psicopedagog', 'aprendizado', 'escola', 'dislexia', 'dificuldade de aprender'],
  'neuropsicologia': ['neuropsicolog', 'avaliação neuro', 'memória', 'concentração'],
  'musicoterapia': ['musicoterapia', 'música', 'musical']
};

const INTENCAO_PATTERNS = {
  'preco': /\b(valor|custa|pre[çc]o|quanto|investimento|paga)\b/i,
  'agendamento': /\b(agendar|marcar|consulta|vaga|horario|hora|disponibilidade|quando)\b/i,
  'plano': /\b(plano|conv[eê]nio|sa[uú]de|ipasgo|unimed|reembolso)\b/i,
  'endereco': /\b(onde|endere[çc]o|local|fica|chegar)\b/i,
  'confirmacao': /\b(sim|quero|pode|claro|ok|tudo bem|vamos|top|beleza|combinado)\b/i,
  'negacao': /\b(n[ãa]o|não quero|depois|outra hora|agora n[ãa]o)\b/i
};

const TIPO_PACIENTE_INDICATORS = {
  'crianca': /\b(filho|filha|pequeno|pequena|crian[çc]a|bebe|beb[eê]|nen[eê]|baby)\b/i,
  'adulto': /\b(eu mesmo|pra mim|para mim|sou eu|adulto|marido|esposa|m[aã]e|pai)\b/i
};

// Palavras que definitivamente NÃO são nomes
const NON_NAME_WORDS = [
  'sim', 'não', 'nao', 'talvez', 'ok', 'beleza', 'blz', 'top', 'nice',
  'tudo', 'bem', 'bom', 'boa', 'dia', 'tarde', 'noite',
  'hoje', 'amanhã', 'amanha', 'ontem',
  'pix', 'cartão', 'cartao', 'dinheiro', 'online', 'presencial',
  'oi', 'olá', 'ola', 'quero', 'queria', 'gostaria', 'preciso',
  'agendar', 'marcar', 'agendamento', 'consulta', 'para', 'pra',
  'fazer', 'faz', 'saber', 'informação', 'ajuda', 'ajudar'
];

/**
 * 🎯 Extrai entidades de uma mensagem
 */
export function extractEntities(text, context = {}) {
  if (!text || typeof text !== 'string') {
    return { lastMessage: '', rawText: '' };
  }
  
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { lastMessage: '', rawText: text };
  }
  
  const lowered = trimmed.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = trimmed.split(/\s+/);
  
  const extracted = {
    lastMessage: trimmed,
    rawText: text  // Preserva original para escape hatch
  };
  
  // ═══════════════════════════════════════════════════════════
  // ORDEM DE EXTRAÇÃO
  // ═══════════════════════════════════════════════════════════
  
  // 1️⃣ ESCAPE HATCH - Verifica se usuário disse explicitamente o nome
  const explicitName = checkExplicitName(text);
  if (explicitName) {
    extracted._explicitName = explicitName.name;
    console.log(`[EntityExtractor] Escape hatch detectado: "${explicitName.name}"`);
  }
  
  // 2️⃣ IDADE
  extractAge(trimmed, lowered, extracted);
  
  // 3️⃣ PERÍODO
  extractPeriod(lowered, extracted);
  
  // 4️⃣ TERAPIA
  extractTherapy(lowered, extracted);
  
  // 5️⃣ INTENÇÃO
  extractIntencao(lowered, extracted);
  
  // 6️⃣ TIPO DE PACIENTE
  extractTipoPaciente(lowered, extracted);
  
  // 7️⃣ QUEIXA
  extractComplaint(trimmed, lowered, words, extracted);
  
  // 8️⃣ NOME (com lógica aprimorada)
  extractName(trimmed, lowered, words, context, extracted, explicitName);
  
  return extracted;
}

function extractAge(text, lowered, extracted) {
  const idadePatterns = [
    { regex: /(\d+)\s*anos?\s*(?:de\s*idade)?/i, group: 1 },
    { regex: /(\d+)\s*aninhos?/i, group: 1 },
    { regex: /(?:tem|tem\s+a|tem\s*o|tem\s*a)\s*(\d+)\s*(anos?|aninhos?|a)/i, group: 1 },
    { regex: /(\d+)\s*meses?/i, group: 1 },
    { regex: /(\d+)\s*a(?:\s|$|\.|,)/i, group: 1 },
    { regex: /(?:idade|anos)[^\d]*(\d+)/i, group: 1 },
  ];
  
  for (const pattern of idadePatterns) {
    const match = text.match(pattern.regex);
    if (match && match[pattern.group]) {
      const age = parseInt(match[pattern.group], 10);
      if (isValidAge(age)) {
        extracted.age = age;
        return;
      }
    }
  }
}

function extractPeriod(lowered, extracted) {
  if (/\b(manh[ãa]|cedo|8h|9h|10h|11h|08|09|10|11)\b/.test(lowered)) {
    extracted.period = 'manha';
  } else if (/\b(tarde|14h|15h|16h|17h|14|15|16|17)\b/.test(lowered)) {
    extracted.period = 'tarde';
  }
}

function extractTherapy(lowered, extracted) {
  for (const [therapy, keywords] of Object.entries(THERAPY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowered.includes(keyword)) {
        extracted.therapy = therapy;
        return;
      }
    }
  }
}

function extractIntencao(lowered, extracted) {
  const prioridades = ['preco', 'plano', 'endereco', 'agendamento', 'confirmacao', 'negacao'];
  
  for (const intencao of prioridades) {
    if (INTENCAO_PATTERNS[intencao].test(lowered)) {
      extracted.intencao = intencao;
      if (intencao === 'confirmacao') extracted.isConfirmation = true;
      if (intencao === 'negacao') extracted.isNegation = true;
      return;
    }
  }
  
  extracted.intencao = 'informacao';
}

function extractTipoPaciente(lowered, extracted) {
  if (TIPO_PACIENTE_INDICATORS.crianca.test(lowered)) {
    extracted.tipo_paciente = 'crianca';
  } else if (TIPO_PACIENTE_INDICATORS.adulto.test(lowered)) {
    extracted.tipo_paciente = 'adulto';
  }
}

function extractComplaint(text, lowered, words, extracted) {
  const isQuestion = /^(qual|quanto|onde|como|voc[eê]s?|t[eê]m|faz)/i.test(text.trim());
  const isGreeting = /^(oi|ol[aá]|bom dia|boa tarde|boa noite)[\s!,.]*$/i.test(text.trim());
  const isShort = words.length <= 3 && text.length < 30;
  
  if (!isQuestion && !isGreeting && !isShort && text.length > 10) {
    let complaint = text.replace(/^(oi|ol[aá]|bom dia|boa tarde|boa noite)[,\s]*/i, '');
    if (complaint.length > 15 && complaint.length <= 250) {
      extracted.complaint = complaint;
    }
  }
}

function extractName(text, lowered, words, context, extracted, explicitName) {
  const wordCount = words.length;
  
  // 🛡️ PRIORIDADE 1: Escape hatch
  if (explicitName && explicitName.name) {
    const cleaned = cleanName(explicitName.name);
    if (cleaned) {
      extracted.patientName = cleaned;
      extracted._nameSource = 'escape_hatch';
      console.log(`[EntityExtractor] Nome via escape hatch: ${cleaned}`);
      return;
    }
  }
  
  // 🛡️ PRIORIDADE 2: Se tem muitas palavras, não é só um nome
  if (wordCount > 6) {
    console.log(`[EntityExtractor] Muitas palavras (${wordCount}), pulando extração de nome`);
    return;
  }
  
  // 🛡️ PRIORIDADE 3: Se começa com número, não é nome
  if (/^\d/.test(text)) {
    return;
  }
  
  // 🛡️ PRIORIDADE 4: Se todas as palavras são não-nomes
  const allWordsNonNames = words.every(w => 
    NON_NAME_WORDS.includes(w.toLowerCase().replace(/[^a-záéíóúâêîôûãõäëïöüàèìòùç]/g, ''))
  );
  if (allWordsNonNames) {
    return;
  }
  
  // Se já extraímos idade E o texto tem formato de idade, somos mais cuidadosos
  const hasAge = extracted.age !== undefined;
  
  // 🔍 PADRÕES ESPECÍFICOS DE NOME
  const namePatterns = [
    // "A X tem Y anos" ou "X tem Y anos" (nome antes da idade)
    /^([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+)(?:\s+tem\s+\d+|,\s*\d+\s*anos)/i,
    // "X, Y anos"
    /^([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+(?:\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+)?)[,\s]+\d+/i,
  ];
  
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const potentialName = cleanName(match[1]);
      if (potentialName) {
        const validationContext = { 
          ...context, 
          rawText: text,
          hasAgeInMessage: hasAge
        };
        
        if (isValidName(potentialName, validationContext)) {
          extracted.patientName = potentialName;
          extracted._nameSource = 'pattern_with_age';
          console.log(`[EntityExtractor] Nome extraído (padrão com idade): ${potentialName}`);
          return;
        }
      }
    }
  }
  
  // Se tem idade mas não encontrou padrão específico, somos conservadores
  if (hasAge && wordCount <= 2) {
    // Só aceita se for nome muito claro (ex: "Ana Clara" em vez de "2 anos")
    const potentialName = cleanName(text);
    if (potentialName && /^[A-Z]/.test(potentialName) && !/\d/.test(potentialName)) {
      // Verifica se parece nome (tem vogal, não é só consoantes)
      if (/[aeiouáéíóúâêîôûãõäëïöüàèìòù]/i.test(potentialName)) {
        extracted.patientName = potentialName;
        extracted._nameSource = 'heuristic_with_age_check';
        console.log(`[EntityExtractor] Nome extraído (heurística cuidadosa): ${potentialName}`);
        return;
      }
    }
    
    console.log(`[EntityExtractor] Pulando: mensagem contém idade e não encontrou padrão claro de nome`);
    return;
  }
  
  // 🔍 HEURÍSTICA PARA RESPOSTA CURTA (sem idade na mensagem)
  if (wordCount >= 1 && wordCount <= 3) {
    const potentialName = cleanName(text);
    
    if (potentialName) {
      const isNameQuestionContext = context.lastQuestion === 'name' || 
                                   context.currentStep === 'missing_patientName';
      
      const validationContext = {
        ...context,
        rawText: text,
        hasAgeInMessage: false,
        lastQuestion: isNameQuestionContext ? 'name' : context.lastQuestion
      };
      
      if (isValidName(potentialName, validationContext)) {
        extracted.patientName = potentialName;
        extracted._nameSource = 'heuristic';
        console.log(`[EntityExtractor] Nome extraído via heurística: ${potentialName}`);
      }
    }
  }
}

export default {
  extractEntities,
  THERAPY_KEYWORDS,
  INTENCAO_PATTERNS
};
