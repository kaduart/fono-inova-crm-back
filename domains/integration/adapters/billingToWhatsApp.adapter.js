/**
 * ============================================================================
 * ADAPTER: Billing → WhatsApp
 * ============================================================================
 *
 * Traduz eventos do domínio financeiro para mensagens WhatsApp.
 * Não contém regra de negócio — apenas mapeamento de payload.
 * ============================================================================
 */

/**
 * PAYMENT_COMPLETED → WHATSAPP_MESSAGE_REQUESTED
 *
 * Sem patientId não há destinatário — descarta silenciosamente.
 *
 * @param {Object} event - Job data do BullMQ (eventType + payload)
 * @returns {{ type: string, payload: Object } | null}
 */
export function mapPaymentCompleted(event) {
    const { patientId, paymentId, amount, paymentType } = event.payload;

    if (!patientId) return null;

    return {
        type: 'WHATSAPP_MESSAGE_REQUESTED',
        payload: {
            patientId,
            template: 'payment_confirmation',
            data: {
                paymentId,
                amount,
                paymentType,
            },
        },
    };
}
