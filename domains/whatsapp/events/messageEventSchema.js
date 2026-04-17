/**
 * 📋 Schema de Eventos do Domínio WhatsApp
 *
 * Objetivo: eliminar schema implícito entre workers.
 * Todo evento publicado/consumido por mais de um worker deve ter
 * seu contrato documentado aqui.
 */

export const MessageDirections = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
};

export const MessageSources = {
  WHATSAPP: 'whatsapp',
  INTERNAL: 'internal',
  WEBHOOK: 'webhook',
};

/**
 * Contrato do evento MESSAGE_PERSISTED
 *
 * Produtor: messagePersistenceWorker
 * Consumidores: realtimeWorker, leadInteractionWorker, chatProjectionWorker
 */
export const MessagePersistedSchema = {
  requiredFields: [
    'messageId',
    'from',
    'to',
    'type',
    'content',
    'timestamp',
    'direction',
  ],

  /**
   * Valida payload e retorna { valid: boolean, errors: string[] }
   */
  validate(payload) {
    const errors = [];
    for (const field of this.requiredFields) {
      if (payload[field] === undefined || payload[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    if (
      payload.direction !== undefined &&
      !Object.values(MessageDirections).includes(payload.direction)
    ) {
      errors.push(
        `Invalid direction: ${payload.direction}. Allowed: ${Object.values(
          MessageDirections
        ).join(', ')}`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

/**
 * Contrato do evento WHATSAPP_MESSAGE_PREPROCESSED
 *
 * Produtor: whatsappInboundWorker
 * Consumidor: messagePersistenceWorker
 */
export const WhatsappMessagePreprocessedSchema = {
  requiredFields: ['msg', 'value'],
};
