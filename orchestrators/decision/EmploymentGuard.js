/**
 * 🛡️ EmploymentGuard - Proteção contra falso positivo de emprego
 * 
 * REGRA DE OURO: Se tem contexto de paciente → NUNCA é emprego
 */

// Palavras que DEFINITIVAMENTE indicam emprego
const EMPLOYMENT_KEYWORDS = [
  'vaga',
  'currículo',
  'curriculo',
  'enviar cv',
  'me candidatar',
  'processo seletivo',
  'oportunidade de trabalho',
  'quero trabalhar',
  'tenho interesse em trabalhar',
  'sou profissional',
  'me formei'
];

// Palavras que indicam PACIENTE (contexto proibido para emprego)
const PATIENT_CONTEXT = [
  'meu filho',
  'minha filha',
  'meu bebê',
  'minha criança',
  'ele precisa',
  'ela precisa',
  'tem dificuldade',
  'não fala',
  'atraso',
  'problema',
  'queixa',
  'sintoma',
  'meu filho precisa',
  'minha filha precisa'
];

/**
 * Verifica se é intenção de emprego SEGURA
 * @param {string} text - Mensagem do lead
 * @returns {boolean} true apenas se for SEGURO classificar como emprego
 */
export function isSafeEmploymentIntent(text) {
  if (!text) return false;
  
  const lowerText = text.toLowerCase();
  
  // ⚠️ VERIFICAÇÃO CRÍTICA: Se tem contexto de paciente → NUNCA é emprego
  const hasPatientContext = PATIENT_CONTEXT.some(ctx => 
    lowerText.includes(ctx.toLowerCase())
  );
  
  if (hasPatientContext) {
    console.log('🛡️ [EmploymentGuard] BLOQUEADO: Contexto de paciente detectado');
    return false;
  }
  
  // Só é emprego se tiver palavras-chave ESPECÍFICAS de emprego
  const hasEmploymentKeyword = EMPLOYMENT_KEYWORDS.some(kw => 
    lowerText.includes(kw.toLowerCase())
  );
  
  return hasEmploymentKeyword;
}

/**
 * Verifica se tem contexto de paciente
 */
export function hasPatientContext(text) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return PATIENT_CONTEXT.some(ctx => lowerText.includes(ctx.toLowerCase()));
}

/**
 * Log para debug
 */
export function logEmploymentCheck(text, result) {
  console.log(`🛡️ [EmploymentGuard] "${text.substring(0, 40)}..." → ${result ? 'EMPREGO' : 'NÃO É EMPREGO'}`);
}
