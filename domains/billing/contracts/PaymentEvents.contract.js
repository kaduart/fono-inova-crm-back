/**
 * ============================================================================
 * PAYMENT EVENTS CONTRACT — Billing Domain
 * ============================================================================
 *
 * Contrato oficial de eventos do domínio Billing (Payment).
 *
 * Regras:
 * - Todos os eventos de pagamento devem seguir este contrato
 * - Payloads são validados antes de publicar via validatePaymentEvent()
 * - Mudanças estruturais devem incrementar a versão do evento afetado
 * - NÃO remover campos required sem bump de versão major
 *
 * Fases de migração do post('save') hook:
 *   Phase 1 — PAYMENT_CREATED publicado pelo worker (hook ainda ativo) ✅
 *   Phase 2 — Criar consumers que replicam o comportamento do hook
 *   Phase 3 — Validar parity (hook + event produzem mesmo estado)
 *   Phase 4 — Remover hook
 * ============================================================================
 */

export const PaymentEventTypes = {

    // =========================================================================
    // CICLO DE VIDA DO PAGAMENTO
    // =========================================================================

    /**
     * Payment criado automaticamente pelo billing worker.
     * Substitui gradualmente o post('save') hook do model Payment.
     * @version 1
     */
    PAYMENT_CREATED: {
        type:        'PAYMENT_CREATED',
        version:     1,
        required:    ['paymentId', 'patientId', 'appointmentId', 'amount', 'status', 'paymentOrigin'],
        optional:    ['sessionId', 'packageId', 'paymentMethod', 'billingType', 'correlationId', 'kind'],
        description: 'Payment criado pelo billing worker após conclusão de appointment',
        queues:      ['patient-projection'],
        idempotent:  true,
    },

    /**
     * Status do payment mudou (paid, partial, canceled, recognized…).
     * Evento central da migração: substitui o post('save') hook.
     * @version 1
     */
    PAYMENT_STATUS_CHANGED: {
        type:        'PAYMENT_STATUS_CHANGED',
        version:     1,
        required:    ['paymentId', 'patientId', 'status', 'changedAt'],
        optional:    ['previousStatus', 'appointmentId', 'sessionId', 'packageId', 'amount', 'correlationId'],
        description: 'Status do payment mudou — consumido por appointment-worker e session-worker para sync',
        queues:      ['patient-projection'],
        idempotent:  true,
        migrationNote: 'Phase 2: adicionar appointment-processing quando handler for criado',
    },

    /**
     * Payment confirmado como pago (dinheiro em caixa).
     * @version 1
     */
    PAYMENT_CONFIRMED: {
        type:        'PAYMENT_CONFIRMED',
        version:     1,
        required:    ['paymentId', 'patientId', 'amount', 'confirmedAt'],
        optional:    ['appointmentId', 'sessionId', 'paymentMethod', 'correlationId'],
        description: 'Pagamento confirmado como recebido',
        queues:      ['patient-projection', 'balance-update'],
        idempotent:  true,
    },

    /**
     * Payment cancelado (compensação de saga).
     * @version 1
     */
    PAYMENT_CANCELLED: {
        type:        'PAYMENT_CANCELLED',
        version:     1,
        required:    ['paymentId', 'patientId', 'cancelledAt'],
        optional:    ['appointmentId', 'sessionId', 'reason', 'correlationId'],
        description: 'Payment cancelado — rollback de transação ou cancelamento manual',
        queues:      ['patient-projection'],
        idempotent:  true,
    },

    // =========================================================================
    // CONVÊNIO
    // =========================================================================

    /**
     * Payment de convênio reconhecido após recebimento do lote.
     * @version 1
     */
    INSURANCE_PAYMENT_RECOGNIZED: {
        type:        'INSURANCE_PAYMENT_RECOGNIZED',
        version:     1,
        required:    ['paymentId', 'patientId', 'amount', 'batchId', 'recognizedAt'],
        optional:    ['glosa', 'sessionId', 'correlationId'],
        description: 'Receita de convênio reconhecida após liquidação do lote',
        queues:      ['patient-projection', 'balance-update'],
        idempotent:  true,
    },
};

// =============================================================================
// VALIDAÇÃO
// =============================================================================

/**
 * Valida um payload contra o contrato do evento.
 *
 * @param {string} eventType
 * @param {Object} payload
 * @returns {{ valid: boolean, errors: string[], warnings: string[], contract: Object }}
 */
export function validatePaymentEvent(eventType, payload) {
    const contract = PaymentEventTypes[eventType];

    if (!contract) {
        return {
            valid:    false,
            errors:   [`Event type '${eventType}' not in PaymentEvents contract`],
            warnings: [],
            contract: null,
        };
    }

    const errors = [];

    for (const field of contract.required) {
        if (payload[field] === undefined || payload[field] === null) {
            errors.push(`Missing required field: ${field}`);
        }
    }

    const known    = [...contract.required, ...contract.optional];
    const unknown  = Object.keys(payload).filter(f => !known.includes(f));

    return {
        valid:    errors.length === 0,
        errors,
        warnings: unknown.length > 0 ? [`Unknown fields: ${unknown.join(', ')}`] : [],
        contract: { type: contract.type, version: contract.version, queues: contract.queues },
    };
}

// =============================================================================
// IDEMPOTÊNCIA
// =============================================================================

/**
 * Gera idempotencyKey estável para eventos de payment.
 *
 * Formato: payment:{paymentId}:{action}
 * Se paymentId não existe ainda (PAYMENT_CREATED), usa correlationId como anchor.
 *
 * @param {string} eventType
 * @param {Object} payload
 * @returns {string}
 */
export function generatePaymentIdempotencyKey(eventType, payload) {
    const anchor = payload.paymentId || payload.correlationId || 'unknown';
    const action = eventType.toLowerCase().replace(/_/g, '-');
    return `payment:${anchor}:${action}`;
}

export default PaymentEventTypes;
