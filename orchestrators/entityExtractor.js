/**
 * 🧩 ENTITY EXTRACTOR
 *
 * Funções reutilizáveis para extração de entidades de mensagens.
 * Usado pelo Orchestrator V7 e outros componentes.
 */

import { sanitizeObject } from '../utils/sanitizer.js';

/**
 * Extrai entidades de uma mensagem de forma inteligente e contextual
 * Não depende de "steps" - extrai o que encontrar, quando encontrar
 * 🔒 FIX: Sanitiza todas as entidades extraídas para prevenir XSS e Prompt Injection
 */
export function extractEntities(text, context = {}) {
  if (!text || typeof text !== 'string') return {};

  const lowered = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const extracted = {};
  const words = text.trim().split(/\s+/);

  // ========================================================================
  // 1. EXTRAÇÃO DE NOME (heurística contextual)
  // ========================================================================
  if (words.length >= 1 && words.length <= 4 && text.length > 1) {
    // 🔧 FIX BUG #2: Blacklist de termos médicos para evitar "Psicologia Infantil" ser aceito como nome
    const MEDICAL_TERMS = [
      'psicologia', 'psicologa', 'psicologo', 'psico',
      'pediatra', 'pediatria',
      'fono', 'fonoaudiologa', 'fonoaudiologo', 'fonoaudiologia',
      'fisioterapia', 'fisioterapeuta', 'fisio',
      'terapia', 'terapeuta',
      'neuropsicologia', 'neuropsicolog', 'neuro',
      'ocupacional',
      'psicopedagogia', 'psicopedagog',
      'musicoterapia',
      'infantil', 'adulto', 'adolescente'
    ];

    const noiseWords = ['nao', 'não', 'sim', 'talvez', 'ok', 'blz', 'beleza', 'opa', 'oi', 'ola', 'tudo'];
    const firstWord = words[0].toLowerCase().replace(/[^a-z]/g, '');

    if (!noiseWords.includes(firstWord) && !text.match(/^\d+$/)) {
      // 🔧 FIX BUG #2: Verifica se o texto contém termos médicos
      const textLowered = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const containsMedicalTerm = MEDICAL_TERMS.some(term => textLowered.includes(term));

      if (containsMedicalTerm) {
        // Não é um nome, é uma especialidade médica
        console.log('🚫 Termo médico detectado, não será extraído como nome:', text);
      } else {
        const isLikelyName = words[0][0] === words[0][0]?.toUpperCase() ||
          context?.lastQuestion === 'nome' ||
          words.length <= 2;

        if (isLikelyName && text.length >= 2 && text.length <= 40) {
          const cleanedName = text.trim().replace(/[.,!?;:]$/, '');
          if (!cleanedName.toLowerCase().match(/^(nao|não|sim|na)$/)) {
            extracted.patientName = cleanedName;
          }
        }
      }
    }
  }

  // ========================================================================
  // 2. EXTRAÇÃO DE IDADE (múltiplos padrões)
  // ========================================================================
  const idadePatterns = [
    /(\d+)\s*(anos?|a)/i,
    /(\d+)\s*anos?\s*de\s*idade/i,
    /tem\s*(\d+)\s*(anos?)?/i,
    /(\d+)\s*aninhos?/i,
    /(\d+)\s*meses?/i,
    /(\d+)[\s]*a/i
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
  // 3. EXTRAÇÃO DE ESPECIALIDADE/TERAPIA
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

  // ========================================================================
  // 6. QUEIXA/DESCRICAO (extrair se não for pergunta curta)
  // ========================================================================
  const isQuestion = /^(qual|quanto|onde|como|voce|voces|tem|faz|aceita|trabalha|pode)/i.test(text.trim());
  const isGreeting = /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|td bem)[\s!,.]*$/i.test(text.trim());

  if (!isQuestion && !isGreeting && text.length > 10 && !extracted.patientName && !extracted.age) {
    let complaint = text.replace(/^(oi|ola|bom dia|boa tarde|boa noite)[,\s]*/i, '').substring(0, 250);
    if (complaint.length > 20) {
      extracted.complaint = complaint;
    }
  }

  // 🔒 FIX: Sanitiza todas as entidades extraídas antes de retornar
  // Previne XSS (ex: patientName = "<script>alert('xss')</script>")
  // Previne Prompt Injection (ex: complaint = "Ignore previous instructions...")
  const sanitized = sanitizeObject(extracted, ['patientName', 'complaint', 'therapy']);

  return sanitized;
}

/**
 * Determina quais entidades ainda estão faltando
 * Retorna array ordenado por prioridade de pergunta
 */
export function getMissingEntities(context) {
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
