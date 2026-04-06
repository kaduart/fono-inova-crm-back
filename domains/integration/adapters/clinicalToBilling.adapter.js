/**
 * ============================================================================
 * ADAPTER: Clinical → Billing
 * ============================================================================
 *
 * Traduz eventos do domínio clínico para eventos de billing.
 * Não contém regra de negócio — apenas mapeamento de payload.
 * ============================================================================
 */

import { IntegrationEventTypes } from '../events/integrationEvents.js';

/**
 * APPOINTMENT_COMPLETED → APPOINTMENT_BILLING_REQUESTED
 *
 * Só traduz se o appointment tiver dados de pagamento.
 * Sessions de convênio são tratadas pelo billingConsumerWorker via SESSION_COMPLETED.
 *
 * @param {Object} event - Job data do BullMQ (eventType + payload)
 * @returns {{ type: string, payload: Object } | null}
 */
export function mapAppointmentCompleted(event) {
    const { appointmentId, patientId, paymentType, amount, sessionId } = event.payload;

    if (!appointmentId) return null;

    return {
        type: IntegrationEventTypes.APPOINTMENT_BILLING_REQUESTED,
        payload: {
            appointmentId,
            patientId,
            paymentType,
            amount,
            sessionId,
        },
    };
}

/**
 * SESSION_COMPLETED → SESSION_BILLING_REQUESTED
 *
 * Convênio NÃO é roteado aqui — billingConsumerWorker já o consome
 * diretamente via billing-orchestrator.
 * Apenas particular e pacote chegam aqui.
 *
 * @param {Object} event
 * @returns {{ type: string, payload: Object } | null}
 */
export function mapSessionCompleted(event) {
    const { sessionId, patientId, paymentType, amount, appointmentId } = event.payload;

    if (!sessionId) return null;

    // Convênio já tem dono — billingConsumerWorker
    if (paymentType === 'convenio') return null;

    return {
        type: IntegrationEventTypes.SESSION_BILLING_REQUESTED,
        payload: {
            sessionId,
            patientId,
            paymentType,
            amount,
            appointmentId,
        },
    };
}
