// domain/fiscal/events/publishFiscalDomainEvent.js
// Reutiliza o Outbox já existente no CRM (infrastructure/outbox/outboxPattern.js) em vez de
// inventar um mecanismo paralelo. `saveToOutbox` só grava o registro `pending` — a fila BullMQ
// real (eventToQueueMap) só passa a existir quando o PR4 mapear estes eventTypes. Até lá, o
// evento fica no Outbox sem ser despachado, o que é seguro (não quebra nada) e permite que o
// domínio já publique eventos desde o PR2.

import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';

/**
 * @param {string} eventType - use FiscalDomainEventTypes
 * @param {Object} payload
 * @param {{ aggregateId: string, correlationId?: string, session?: object }} options
 */
export async function publishFiscalDomainEvent(eventType, payload, { aggregateId, correlationId, session } = {}) {
  return saveToOutbox(
    {
      eventType,
      payload,
      aggregateType: 'fiscal_invoice',
      aggregateId: String(aggregateId),
      correlationId
    },
    session
  );
}
