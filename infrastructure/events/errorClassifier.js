// infrastructure/events/errorClassifier.js
/**
 * Classificação de erros em retryable vs non-retryable
 *
 * Erros não retryable são movidos diretamente para permanent_failure / dead_letter
 * sem gastar tentativas inúteis.
 */

import { ErrorCodes } from './errorCodes.js';

// Códigos/mensagens que NUNCA devem ser retryados
const NON_RETRYABLE_PATTERNS = [
    'INVALID_PAYLOAD',
    'INVALID_ENTITY_ID',
    'BUSINESS_RULE_VIOLATION',
    'UNKNOWN_ENTITY_TYPE',
    'UPDATE_NOT_SUPPORTED_FOR',
    '_MISSING',
    'Cannot modify canceled',
    'Cannot modify completed',
    'Paid invoice can only be canceled',
    'null',
    'undefined',
    'Cast to ObjectId failed',
    'Validation failed',
    'E11000' // duplicate key em alguns casos (depende do contexto)
];

// Erros de infra que SEMPRE podem ser retryados
const RETRYABLE_PATTERNS = [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'socket hang up',
    'MongoNetworkError',
    'MongoServerSelectionError',
    'Write conflict',
    'Transaction aborted',
    'NOT_READY'
];

/**
 * Classe para erros que não devem ser retryados
 */
export class NonRetryableError extends Error {
    constructor(message, code = ErrorCodes.NON_RETRYABLE) {
        super(message);
        this.name = 'NonRetryableError';
        this.code = code;
        this.retryable = false;
    }
}

/**
 * Classe para erros permanentes (causa raiz já conhecida)
 */
export class PermanentFailureError extends Error {
    constructor(message, code = ErrorCodes.PERMANENT_FAILURE) {
        super(message);
        this.name = 'PermanentFailureError';
        this.code = code;
        this.retryable = false;
    }
}

/**
 * Classifica se um erro é retryable ou não
 *
 * @param {Error} error
 * @returns {Object} { retryable: boolean, permanent: boolean }
 */
export function classifyError(error) {
    if (!error) return { retryable: true, permanent: false };

    // Já é instância de NonRetryableError
    if (error instanceof NonRetryableError || error instanceof PermanentFailureError) {
        return { retryable: false, permanent: true };
    }

    const message = (error.message || '').toLowerCase();
    const code = (error.code || '').toString().toLowerCase();

    // Retryable wins first (infra)
    for (const pattern of RETRYABLE_PATTERNS) {
        const p = pattern.toLowerCase();
        if (message.includes(p) || code.includes(p)) {
            return { retryable: true, permanent: false };
        }
    }

    // Non-retryable (lógica/negócio/dados)
    for (const pattern of NON_RETRYABLE_PATTERNS) {
        const p = pattern.toLowerCase();
        if (message.includes(p) || code.includes(p)) {
            return { retryable: false, permanent: true };
        }
    }

    // Default: retryable (assumir que é transitório)
    return { retryable: true, permanent: false };
}

/**
 * Helper para criar NonRetryableError a partir de validação de payload
 */
export function assertPayloadField(value, fieldName, entity = '') {
    if (!value) {
        const prefix = entity ? `${entity}_` : '';
        throw new NonRetryableError(
            `${prefix.toUpperCase()}${fieldName.toUpperCase()}_MISSING`,
            ErrorCodes.MISSING_REQUIRED_FIELD
        );
    }
}

/**
 * Helper para decidir se um NOT_FOUND deve ser retryado ou não.
 * Útil para race conditions onde o dado pode ainda não estar replicado.
 */
export function throwIfNotFoundRetryable(entityName, entityId, attemptsMade, maxAttempts = 3) {
    if (attemptsMade < maxAttempts) {
        const error = new Error(`${entityName}_NOT_READY: ${entityId} (attempt ${attemptsMade + 1}/${maxAttempts})`);
        error.code = 'NOT_READY';
        throw error;
    }
    throw new NonRetryableError(
        `${entityName}_NOT_FOUND_FINAL: ${entityId}`,
        ErrorCodes.RESOURCE_NOT_FOUND
    );
}
