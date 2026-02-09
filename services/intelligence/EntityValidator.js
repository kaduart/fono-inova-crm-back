/**
 * 🔍 EntityValidator - Validação robusta de entidades extraídas
 * Evita falsos positivos como "2 anos" sendo detectado como nome
 * 
 * Versão 2.1 - Desengessada:
 * - Whitelist dinâmica (arquivo JSON)
 * - Escape hatch para "meu nome é"
 * - Scoring fuzzy em vez de rejeição binária
 */

import { isWhitelisted, getWhitelistStats } from './WhitelistManager.js';

// =============================================================================
// 🚫 PADRÕES QUE INVALIDAM UM NOME (hard rules - poucos e certeiros)
// =============================================================================
const INVALID_NAME_PATTERNS = [
  /^\d+\s*anos?$/i,           // "2 anos", "5 anos" (exato)
  /^\d+\s*aninhos?$/i,        // "2 aninhos"
  /^\d+\s*meses?$/i,          // "18 meses"
  /^\d+\s*a$/i,               // "7 a" (abreviação de anos)
  /^\d+\s*$/,                 // Apenas número seguido de espaço
  /^(sim|n[ãa]o|talvez|ok|beleza|blz|top|nice|yes|no|ñ|n)$/i,
];

// =============================================================================
// ⚠️ INDICADORES DE NÃO-NOME (para scoring)
// =============================================================================
const NEGATIVE_INDICATORS = [
  { pattern: /\d+\s*anos?/, weight: -40 },      // "2 anos"
  { pattern: /\d+\s*aninhos?/, weight: -40 },
  { pattern: /\d+\s*meses?/, weight: -40 },
  { pattern: /^\d+$/, weight: -50 },           // Só números
  { pattern: /manh[ãa]|cedo\s*da/i, weight: -30 },
  { pattern: /tarde\s*da/i, weight: -20 },     // "tarde" com contexto
  { pattern: /noite/i, weight: -30 },
  { pattern: /pix|cart[ãa]o|dinheiro|boleto/i, weight: -40 },
  { pattern: /hoje|amanh[ãa]|ontem/i, weight: -30 },
  { pattern: /^(sim|n[ãa]o|ok|beleza)$/i, weight: -50 },
];

const POSITIVE_INDICATORS = [
  { pattern: /^[A-Z][a-záéíóúâêîôûãõäëïöüàèìòùç]+/, weight: 30 },  // Começa com maiúscula
  { pattern: /\s+[A-Z][a-záéíóúâêîôûãõäëïöüàèìòùç]+/, weight: 20 }, // Nome composto
  { pattern: /^[A-Z][a-z]+\s+[A-Z][a-z]+$/, weight: 40 },           // Dois nomes próprios
];

// =============================================================================
// 🛡️ ESCAPE HATCH - Frases que indicam nome explícito
// Captura só o nome, não o resto da frase
// =============================================================================
const EXPLICIT_NAME_PATTERNS = [
  // "meu nome é X" - para na primeira pontuação ou palavra-chave
  /meu nome [ée]\s+([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+(?:\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+)?)/i,
  // "me chamo X"
  /me chamo\s+([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+(?:\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+)?)/i,
  // "sou o/a X"
  /sou (?:o|a)\s+([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+(?:\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+)?)/i,
  // "nome da criança é X"
  /nome d[ae]\s+(?:crian[çc]a|paciente|filh[oa]|pequen[oa])\s+[ée]\s+([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+(?:\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÄËÏÖÜÀÈÌÒÙÇ][a-záéíóúâêîôûãõäëïöüàèìòùç]+)?)/i,
];

// =============================================================================
// 📊 ESTATÍSTICAS
// =============================================================================
const stats = {
  totalValidations: 0,
  accepted: 0,
  rejected: 0,
  escapeHatchUsed: 0,
  whitelistUsed: 0,
  fuzzyScores: [],
  reasons: {}
};

export function getValidationStats() {
  return { 
    ...stats, 
    whitelistStats: getWhitelistStats(),
    averageScore: stats.fuzzyScores.length > 0 
      ? (stats.fuzzyScores.reduce((a,b) => a+b, 0) / stats.fuzzyScores.length).toFixed(2)
      : 0
  };
}

export function resetValidationStats() {
  stats.totalValidations = 0;
  stats.accepted = 0;
  stats.rejected = 0;
  stats.escapeHatchUsed = 0;
  stats.whitelistUsed = 0;
  stats.fuzzyScores = [];
  stats.reasons = {};
}

// =============================================================================
// 🔍 FUNÇÕES PRINCIPAIS
// =============================================================================

/**
 * 🎯 Verifica se há escape hatch (usuário disse explicitamente o nome)
 * @returns {object|null} { name: string, confidence: 'high' } ou null
 */
export function checkExplicitName(text) {
  for (const pattern of EXPLICIT_NAME_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim().split(/[,.!?;]/)[0]; // Pega até pontuação
      if (candidate.length >= 2 && candidate.length <= 50) {
        return { 
          name: candidate, 
          confidence: 'high',
          method: 'explicit_statement'
        };
      }
    }
  }
  return null;
}

/**
 * 🧮 Calcula score de confiança fuzzy (0-100)
 */
export function calculateNameConfidence(text, context = {}) {
  if (!text || typeof text !== 'string') return 0;
  
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 50) return 0;
  
  let score = 50; // Base neutra
  
  // 🛡️ WHITELIST CHECK (bypass scoring)
  if (isWhitelisted(trimmed)) {
    stats.whitelistUsed++;
    return 100; // Máxima confiança
  }
  
  // Aplica indicadores positivos
  for (const indicator of POSITIVE_INDICATORS) {
    if (indicator.pattern.test(trimmed)) {
      score += indicator.weight;
    }
  }
  
  // Aplica indicadores negativos
  for (const indicator of NEGATIVE_INDICATORS) {
    if (indicator.pattern.test(trimmed)) {
      score += indicator.weight;
    }
  }
  
  // Contexto: se estamos esperando um nome, aumenta score
  if (context.lastQuestion === 'name' || context.currentStep === 'missing_patientName') {
    score += 15;
  }
  
  // Se já temos um nome válido, diminui score (precisa ser "melhor")
  if (context.patientName && isValidName(context.patientName, {})) {
    score -= 20;
  }
  
  // Se mensagem contém idade e este candidato parece idade, penaliza mais
  if (context.hasAgeInMessage && /\d/.test(trimmed)) {
    score -= 30;
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * ✅ Valida se uma string é um nome válido (usando scoring)
 */
export function isValidName(text, context = {}) {
  stats.totalValidations++;
  
  if (!text || typeof text !== 'string') {
    logValidation(text, false, 'invalid_input', 0);
    return false;
  }
  
  const trimmed = text.trim();
  
  // 🚫 HARD RULES - Rejeita imediatamente (sem scoring)
  for (const pattern of INVALID_NAME_PATTERNS) {
    if (pattern.test(trimmed)) {
      logValidation(trimmed, false, 'hard_rule', 0);
      return false;
    }
  }
  
  // 🛡️ ESCAPE HATCH - Se usuário disse explicitamente, aceita
  const explicit = checkExplicitName(context.rawText || trimmed);
  if (explicit && explicit.name.toLowerCase() === trimmed.toLowerCase()) {
    stats.escapeHatchUsed++;
    logValidation(trimmed, true, 'escape_hatch', 100);
    return true;
  }
  
  // 🧮 SCORING FUZZY
  const score = calculateNameConfidence(trimmed, context);
  stats.fuzzyScores.push(score);
  
  const accepted = score >= 60; // Threshold de aceitação
  
  logValidation(trimmed, accepted, accepted ? 'fuzzy_pass' : 'fuzzy_fail', score);
  
  if (accepted) {
    stats.accepted++;
  } else {
    stats.rejected++;
    stats.reasons[`score_${Math.floor(score/10)*10}`] = (stats.reasons[`score_${Math.floor(score/10)*10}`] || 0) + 1;
  }
  
  return accepted;
}

function logValidation(name, accepted, reason, score) {
  const logData = {
    name: name ? `${name.substring(0, 20)}${name.length > 20 ? '...' : ''}` : null,
    accepted,
    reason,
    score,
    timestamp: new Date().toISOString()
  };
  
  if (process.env.DEBUG_ENTITY_VALIDATION === 'true') {
    console.log('[EntityValidator]', JSON.stringify(logData));
  }
}

/**
 * ✅ Valida idade
 */
export function isValidAge(age) {
  if (age === null || age === undefined) return false;
  const numAge = typeof age === 'string' ? parseInt(age, 10) : age;
  return !isNaN(numAge) && numAge >= 0 && numAge <= 120;
}

/**
 * ✅ Valida terapia
 */
export function isValidTherapy(therapy) {
  if (!therapy || typeof therapy !== 'string') return false;
  const validTherapies = [
    'fonoaudiologia', 'psicologia', 'fisioterapia', 
    'terapia_ocupacional', 'psicopedagogia', 
    'neuropsicologia', 'musicoterapia', 'psicomotricidade'
  ];
  return validTherapies.includes(therapy.toLowerCase());
}

/**
 * ✅ Valida período
 */
export function isValidPeriod(period) {
  if (!period || typeof period !== 'string') return false;
  return ['manha', 'tarde', 'noite', 'manhã'].includes(period.toLowerCase());
}

/**
 * 🧹 Limpa nome
 */
export function cleanName(name) {
  if (!name || typeof name !== 'string') return null;
  
  let cleaned = name.trim().replace(/[.,!?;:]$/, '');
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.split(' ').map(word => {
    if (word.length === 0) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
  
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * 🔄 Decide se aceita nova entidade
 */
export function shouldAcceptNewEntity(field, newValue, existingValue, extracted = {}, context = {}) {
  if (!newValue) return false;
  if (!existingValue) {
    if (field === 'patientName') {
      return isValidName(newValue, { ...context, rawText: extracted.rawText });
    }
    return true;
  }
  if (newValue === existingValue) return false;
  
  switch (field) {
    case 'patientName': {
      const validationContext = { 
        ...context, 
        rawText: extracted.rawText,
        hasAgeInMessage: extracted.age !== undefined,
        patientName: existingValue
      };
      
      const newScore = calculateNameConfidence(newValue, validationContext);
      const existingScore = calculateNameConfidence(existingValue, {});
      
      // Só troca se novo score for significativamente maior
      if (newScore > existingScore + 20) {
        console.log(`[EntityValidator] Trocando nome: "${existingValue}" (score ${existingScore}) → "${newValue}" (score ${newScore})`);
        return true;
      }
      
      if (newScore < 60) {
        console.log(`[EntityValidator] Rejeitando nome "${newValue}" (score ${newScore})`);
        return false;
      }
      
      return false; // Mantém existente se scores similares
    }
      
    case 'age':
      return isValidAge(newValue);
      
    case 'therapy':
      return isValidTherapy(newValue) && !existingValue;
      
    case 'period':
      return isValidPeriod(newValue);
      
    default:
      return true;
  }
}

export default {
  isValidName,
  isValidAge,
  isValidTherapy,
  isValidPeriod,
  cleanName,
  shouldAcceptNewEntity,
  calculateNameConfidence,
  checkExplicitName,
  getValidationStats,
  resetValidationStats
};
