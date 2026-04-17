// infrastructure/events/errorCodes.js
/**
 * Catálogo centralizado de códigos de erro para Event Store e DLQ.
 *
 * Regra: todo erro que leva um evento a dead_letter ou falha permanente
 * deve usar um código deste catálogo. Isso permite:
 * - Observability estruturada
 * - Alertas por categoria
 * - Retry policies determinísticas
 */

export const ErrorCodes = {
    // ========== SCHEMA / CONTRACT ==========
    SCHEMA_MISMATCH: 'SCHEMA_MISMATCH',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    INVALID_FIELD_TYPE: 'INVALID_FIELD_TYPE',
    UNKNOWN_EVENT_TYPE: 'UNKNOWN_EVENT_TYPE',

    // ========== DOMÍNIO / NEGÓCIO ==========
    BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
    INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
    RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
    RESOURCE_NOT_READY: 'RESOURCE_NOT_READY', // race condition temporária

    // ========== INFRAESTRUTURA ==========
    NON_RETRYABLE: 'NON_RETRYABLE',
    PERMANENT_FAILURE: 'PERMANENT_FAILURE',
    TIMEOUT: 'TIMEOUT',
    DATABASE_ERROR: 'DATABASE_ERROR',
    REDIS_ERROR: 'REDIS_ERROR',
    EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',

    // ========== SEGURANÇA / PERMISSÃO ==========
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',

    // ========== GENÉRICO ==========
    UNKNOWN: 'UNKNOWN',
};

/**
 * Determina se um código de erro é retryable (pode tentar de novo)
 */
export function isRetryableErrorCode(code) {
    const retryable = new Set([
        ErrorCodes.RESOURCE_NOT_READY,
        ErrorCodes.TIMEOUT,
        ErrorCodes.DATABASE_ERROR,
        ErrorCodes.REDIS_ERROR,
        ErrorCodes.EXTERNAL_SERVICE_ERROR,
        ErrorCodes.UNKNOWN,
    ]);
    return retryable.has(code);
}

/**
 * Determina se um código de erro deve ir direto para DLQ (sem retry)
 */
export function isDirectDLQCode(code) {
    const dlq = new Set([
        ErrorCodes.SCHEMA_MISMATCH,
        ErrorCodes.MISSING_REQUIRED_FIELD,
        ErrorCodes.INVALID_FIELD_TYPE,
        ErrorCodes.UNKNOWN_EVENT_TYPE,
        ErrorCodes.BUSINESS_RULE_VIOLATION,
        ErrorCodes.INVALID_STATE_TRANSITION,
        ErrorCodes.NON_RETRYABLE,
        ErrorCodes.PERMANENT_FAILURE,
        ErrorCodes.UNAUTHORIZED,
        ErrorCodes.FORBIDDEN,
    ]);
    return dlq.has(code);
}
