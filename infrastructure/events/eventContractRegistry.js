// infrastructure/events/eventContractRegistry.js
/**
 * Event Contract Registry
 *
 * Registry centralizado de schemas/contracts para todos os eventos do sistema.
 * - Zero dependências externas (plain JS)
 - Validação síncrona e leve
 * - Versionamento explícito por evento
 */

import { ErrorCodes } from './errorCodes.js';

// ============================================
// REGISTRY
// ============================================

const registry = new Map();

/**
 * Registra um contract para um eventType
 */
export function registerEventContract(eventType, contract) {
    registry.set(eventType, {
        version: contract.version ?? 1,
        required: contract.required ?? [],
        optional: contract.optional ?? [],
        validators: contract.validators ?? {},
        description: contract.description ?? '',
    });
}

/**
 * Busca um contract pelo eventType
 */
export function getEventContract(eventType) {
    return registry.get(eventType) || null;
}

/**
 * Retorna a versão do schema para um eventType
 */
export function getEventVersion(eventType) {
    return registry.get(eventType)?.version ?? 1;
}

/**
 * Valida um payload contra o contract do eventType
 *
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   code: string | null,
 *   contract: object | null
 * }}
 */
export function validateEvent(eventType, payload) {
    const contract = registry.get(eventType);

    if (!contract) {
        return {
            valid: false,
            errors: [`Event type '${eventType}' não possui contract registrado`],
            warnings: [],
            code: ErrorCodes.UNKNOWN_EVENT_TYPE,
            contract: null,
        };
    }

    const errors = [];
    const warnings = [];

    // 1. Campos obrigatórios
    for (const field of contract.required) {
        if (payload?.[field] === undefined || payload?.[field] === null) {
            errors.push(`Campo obrigatório ausente: ${field}`);
        }
    }

    // 2. Validadores por campo
    for (const [field, validator] of Object.entries(contract.validators)) {
        if (payload?.[field] !== undefined && payload?.[field] !== null) {
            const result = validator(payload[field], payload);
            if (result !== true) {
                errors.push(typeof result === 'string' ? result : `Valor inválido para ${field}`);
            }
        }
    }

    // 3. Campos desconhecidos (warning, não erro)
    const known = new Set([...contract.required, ...contract.optional, ...Object.keys(contract.validators)]);
    for (const key of Object.keys(payload || {})) {
        if (!known.has(key)) {
            warnings.push(`Campo desconhecido: ${key}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        code: errors.length > 0 ? ErrorCodes.SCHEMA_MISMATCH : null,
        contract: {
            type: eventType,
            version: contract.version,
            required: contract.required,
            optional: contract.optional,
        },
    };
}

/**
 * Helper: cria um contract padrão rapidamente
 */
export function defineEventContract(eventType, spec) {
    registerEventContract(eventType, spec);
}

// ============================================
// VALIDADORES REUTILIZÁVEIS
// ============================================

export const V = {
    isString: (msg = 'Deve ser uma string') => (v) => typeof v === 'string' || msg,
    isNumber: (msg = 'Deve ser um número') => (v) => typeof v === 'number' && !isNaN(v) || msg,
    isBoolean: (msg = 'Deve ser um boolean') => (v) => typeof v === 'boolean' || msg,
    isDateString: (msg = 'Deve ser uma data ISO8601 (YYYY-MM-DD)') => (v) => /^\d{4}-\d{2}-\d{2}/.test(v) || msg,
    isTimeString: (msg = 'Deve ser um horário HH:MM') => (v) => /^([0-1]?\d|2[0-3]):[0-5]\d$/.test(v) || msg,
    isMongoId: (msg = 'Deve ser um ID válido (24 caracteres hex)') => (v) => /^[0-9a-fA-F]{24}$/.test(v) || msg,
    isEnum: (values, msg) => (v) => values.includes(v) || (msg || `Deve ser um dos valores: ${values.join(', ')}`),
    isOptionalMongoId: () => (v) => v === null || v === undefined || /^[0-9a-fA-F]{24}$/.test(v) || 'Deve ser um ID válido ou null',
};
