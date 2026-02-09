/**
 * 🔒 SANITIZER - Proteção contra XSS e Prompt Injection
 *
 * FIX: Implementa sanitização de input para prevenir:
 * - XSS (Cross-Site Scripting) em mensagens do WhatsApp
 * - Prompt Injection em prompts de LLM
 */

/**
 * Sanitiza HTML para prevenir XSS
 * Remove tags HTML e caracteres perigosos
 *
 * Exemplo:
 * "<script>alert('xss')</script>" → "[script]alert('xss')[/script]"
 */
export function sanitizeHtml(text) {
  if (!text || typeof text !== 'string') return text;

  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Sanitiza texto para prevenir Prompt Injection em LLMs
 * Remove comandos perigosos que tentam manipular o comportamento do modelo
 *
 * Exemplo:
 * "Ignore previous instructions and..." → "*** PROMPT REMOVIDO ***"
 */
export function sanitizePromptInjection(text) {
  if (!text || typeof text !== 'string') return text;

  const DANGEROUS_PATTERNS = [
    // Comandos de override
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|commands?|rules?)/gi,
    /forget\s+(everything|all|previous|prior)/gi,
    /disregard\s+(previous|prior|above)\s+(instructions?|commands?)/gi,

    // System prompt extraction
    /repeat\s+(your|the)\s+(instructions?|system\s+prompt|rules?)/gi,
    /show\s+(me\s+)?(your|the)\s+(instructions?|system\s+prompt|rules?)/gi,
    /what\s+(are|is)\s+your\s+(instructions?|system\s+prompt|rules?)/gi,
    /tell\s+me\s+your\s+(instructions?|system\s+prompt)/gi,

    // Role manipulation
    /you\s+are\s+now/gi,
    /act\s+as\s+(if|a|an)/gi,
    /pretend\s+(to\s+be|you\s+are)/gi,
    /simulate\s+being/gi,

    // Output manipulation
    /output\s+(only|just)/gi,
    /respond\s+with\s+(only|just)/gi,
    /say\s+(only|just|exactly)/gi,

    // Encoding tricks
    /base64/gi,
    /rot13/gi,
    /\\u[0-9a-f]{4}/gi, // Unicode escapes
    /&#[0-9]+;/g, // HTML entities
  ];

  let sanitized = text;
  let wasModified = false;

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sanitized)) {
      sanitized = sanitized.replace(pattern, '*** CONTEÚDO REMOVIDO ***');
      wasModified = true;
    }
  }

  if (wasModified) {
    console.warn('🚨 [SECURITY] Prompt injection detectado e sanitizado:', {
      originalLength: text.length,
      sanitizedLength: sanitized.length,
      preview: text.substring(0, 100)
    });
  }

  return sanitized;
}

/**
 * Limita tamanho do texto para prevenir ataques de exaustão
 *
 * @param {string} text - Texto a limitar
 * @param {number} maxLength - Tamanho máximo (padrão: 2000 chars)
 */
export function limitLength(text, maxLength = 2000) {
  if (!text || typeof text !== 'string') return text;

  if (text.length > maxLength) {
    console.warn('⚠️ [SECURITY] Texto muito longo truncado:', {
      original: text.length,
      truncated: maxLength
    });
    return text.substring(0, maxLength) + '...';
  }

  return text;
}

/**
 * Sanitização completa: XSS + Prompt Injection + Length Limit
 * Use esta função para todo input de usuário antes de processar
 *
 * @param {string} text - Texto a sanitizar
 * @param {Object} options - Opções de sanitização
 * @param {boolean} options.allowHtml - Permite HTML (padrão: false)
 * @param {boolean} options.checkPromptInjection - Verifica prompt injection (padrão: true)
 * @param {number} options.maxLength - Tamanho máximo (padrão: 2000)
 */
export function sanitize(text, options = {}) {
  const {
    allowHtml = false,
    checkPromptInjection = true,
    maxLength = 2000
  } = options;

  if (!text || typeof text !== 'string') return text;

  let result = text;

  // 1. Limita tamanho
  result = limitLength(result, maxLength);

  // 2. Remove prompt injection
  if (checkPromptInjection) {
    result = sanitizePromptInjection(result);
  }

  // 3. Sanitiza HTML
  if (!allowHtml) {
    result = sanitizeHtml(result);
  }

  return result;
}

/**
 * Sanitiza objeto com múltiplos campos
 * Útil para sanitizar entidades extraídas (patientName, complaint, etc.)
 *
 * @param {Object} obj - Objeto a sanitizar
 * @param {Array<string>} fields - Campos a sanitizar
 */
export function sanitizeObject(obj, fields = ['patientName', 'complaint', 'therapy']) {
  if (!obj || typeof obj !== 'object') return obj;

  const sanitized = { ...obj };

  for (const field of fields) {
    if (sanitized[field]) {
      sanitized[field] = sanitize(sanitized[field], {
        allowHtml: false,
        checkPromptInjection: true,
        maxLength: field === 'complaint' ? 500 : 200
      });
    }
  }

  return sanitized;
}

export default {
  sanitize,
  sanitizeHtml,
  sanitizePromptInjection,
  limitLength,
  sanitizeObject
};
