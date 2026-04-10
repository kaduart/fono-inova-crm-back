/**
 * 🔒 DOMAIN GUARDS - Proteções contra violações de domínio
 * 
 * Essas funções devem ser usadas nos controllers/services para
 * garantir que ninguém tente burlar as regras do domínio.
 */

/**
 * Proíbe setar sessionType manualmente no body da requisição
 * Força o uso do sessionTypeResolver
 */
export function forbidManualSessionType(data, context = '') {
    if (data && 'sessionType' in data) {
        const error = new Error(
            `[DOMAIN LOCK${context ? ` - ${context}` : ''}] ` +
            'Não é permitido setar sessionType manualmente. ' +
            'Use resolveSessionType() ou normalizeSessionType() do sessionTypeResolver.'
        );
        error.code = 'DOMAIN_VIOLATION_SESSION_TYPE';
        error.statusCode = 400;
        throw error;
    }
}

/**
 * Proíbe serviceType inválido ou perigoso
 */
export function validateServiceType(serviceType, allowedTypes = []) {
    const defaultAllowed = [
        'individual_session', 'package_session', 'evaluation',
        'neuropsych_evaluation', 'return', 'convenio_session',
        'alignment', 'meet', 'tongue_tie_test'
    ];
    
    const validTypes = allowedTypes.length > 0 ? allowedTypes : defaultAllowed;
    
    if (serviceType && !validTypes.includes(serviceType)) {
        const error = new Error(
            `[DOMAIN LOCK] serviceType inválido: "${serviceType}". ` +
            `Tipos permitidos: ${validTypes.join(', ')}`
        );
        error.code = 'INVALID_SERVICE_TYPE';
        error.statusCode = 400;
        throw error;
    }
    
    return true;
}

/**
 * Valida que specialty é uma especialidade clínica válida
 */
export function validateSpecialty(specialty, context = '') {
    const validSpecialties = [
        'fonoaudiologia', 'psicologia', 'terapia ocupacional',
        'fisioterapia', 'pediatria', 'neuroped', 'musicoterapia',
        'psicomotricidade', 'psicopedagogia'
    ];
    
    if (specialty && !validSpecialties.includes(specialty)) {
        const error = new Error(
            `[DOMAIN LOCK${context ? ` - ${context}` : ''}] ` +
            `specialty inválida: "${specialty}". ` +
            `Use: ${validSpecialties.join(', ')}`
        );
        error.code = 'INVALID_SPECIALTY';
        error.statusCode = 400;
        throw error;
    }
    
    return true;
}

/**
 * Log de violação de domínio (para monitoramento)
 */
export function logDomainViolation(context, data, req = null) {
    const logEntry = {
        type: 'DOMAIN_VIOLATION',
        context,
        data: sanitizeForLog(data),
        timestamp: new Date().toISOString(),
        path: req?.path,
        method: req?.method,
        userId: req?.user?._id
    };
    
    console.error('[DOMAIN VIOLATION]', JSON.stringify(logEntry, null, 2));
    
    // Aqui poderia enviar para um serviço de monitoramento (Sentry, etc.)
    // if (process.env.SENTRY_DSN) { Sentry.captureMessage(...); }
}

/**
 * Sanitiza dados sensivos para log
 */
function sanitizeForLog(data) {
    if (!data || typeof data !== 'object') return data;
    
    const sensitive = ['password', 'token', 'cpf', 'rg', 'sensitiveData'];
    const sanitized = { ...data };
    
    for (const key of sensitive) {
        if (key in sanitized) {
            sanitized[key] = '[REDACTED]';
        }
    }
    
    return sanitized;
}

export default {
    forbidManualSessionType,
    validateServiceType,
    validateSpecialty,
    logDomainViolation
};
