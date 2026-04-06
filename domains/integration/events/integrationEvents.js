/**
 * ============================================================================
 * INTEGRATION EVENTS
 * ============================================================================
 *
 * Eventos gerados pela camada de integração ao traduzir eventos de domínio.
 * Esses eventos transitam entre domínios sem expor acoplamento direto.
 * ============================================================================
 */

export const IntegrationEventTypes = {
    // Clinical → Billing
    APPOINTMENT_BILLING_REQUESTED: 'APPOINTMENT_BILLING_REQUESTED',
    SESSION_BILLING_REQUESTED:     'SESSION_BILLING_REQUESTED',

    // Billing → WhatsApp
    PAYMENT_CONFIRMATION_REQUESTED: 'PAYMENT_CONFIRMATION_REQUESTED',
};
