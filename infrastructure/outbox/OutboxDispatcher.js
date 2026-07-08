/**
 * @fileoverview OutboxDispatcher
 *
 * Processo único responsável por ler eventos pendentes do Outbox
 * e publicá-los nas filas BullMQ.
 *
 * Não deve ser chamado pelo domínio. É infraestrutura.
 *
 * @see docs/architecture/EVENT_PROJECTION_INVENTORY.md
 */

import { startOutboxDispatcher, publishPendingEvents, cleanupOutbox } from './outboxPattern.js';

export { startOutboxDispatcher, publishPendingEvents, cleanupOutbox };
