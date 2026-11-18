/**
 * @deprecated
 *
 * EventStore puro (appendEvent) NÃO FAZ PARTE DO PIPELINE CANÔNICO.
 *
 * Eventos salvos aqui não são publicados em fila, portanto não chegam aos
 * projection workers. Use infrastructure/outbox/outboxPattern.js (saveToOutbox)
 * dentro da transação MongoDB.
 *
 * Permanece disponível APENAS como histórico/auditoria de eventos já existentes.
 * Novo código de domínio não deve chamar appendEvent.
 *
 * Fluxo oficial: docs/architecture/EVENT_PROJECTION_INVENTORY.md
 */

// infrastructure/events/eventStoreService.js
// Serviço de Event Store - Producer e Consumer de eventos

import EventStore from '../../models/EventStore.js';
import { createContextLogger } from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { classifyError } from './errorClassifier.js';
import {
  claimEvent,
  completeOwned,
  failOwned,
  deadLetterOwned,
  startLeaseKeeper,
  leaseMsFromEnv,
  notLiveOwnedFilter,
  EventBusyError
} from './eventOwnership.js';

/**
 * Falhas registradas antes de ir para dead_letter. Mantém o valor que já
 * existia aqui (5), que coincide com o attempts: 5 padrão das filas BullMQ
 * (infrastructure/queue/queueConfig.js): depois disso o BullMQ não reentrega.
 */
export const MAX_FAILED_ATTEMPTS = 5;

const log = createContextLogger(null, 'event_store');

// ============ PRODUCER ============

/**
 * Salva evento no Event Store (append-only)
 * 
 * @param {Object} eventData - Dados do evento
 * @returns {Promise<Object>} Evento salvo
 */
export async function appendEvent(eventData) {
  console.warn(
    `[DEPRECATED] appendEvent(${eventData?.eventType}) foi chamado. ` +
    `Eventos salvos no EventStore sem publicação em fila não chegam aos projection workers. ` +
    `Use saveToOutbox() de infrastructure/outbox/outboxPattern.js dentro da transação MongoDB.`
  );

  const {
    eventType,
    eventVersion = 1,
    aggregateType,
    aggregateId,
    payload,
    metadata = {},
    idempotencyKey = null,
    correlationId = null,
    ttlDays = null // Tempo de vida do evento (null = eterno)
  } = eventData;

  try {
    // Gera eventId único
    const eventId = uuidv4();

    // Calcula expiresAt se tiver TTL
    let expiresAt = null;
    if (ttlDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + ttlDays);
    }

    // Cria documento
    const event = new EventStore({
      eventId,
      eventType,
      eventVersion,
      aggregateType,
      aggregateId: aggregateId ? String(aggregateId) : 'unknown',
      payload,
      metadata: {
        correlationId,
        ...metadata
      },
      idempotencyKey,
      expiresAt
    });

    await event.save();

    log.debug('event_appended', 'Evento salvo no Event Store', {
      eventId,
      eventType,
      aggregateType,
      aggregateId
    });

    return event.toObject();

  } catch (error) {
    // Verifica se é duplicado (idempotencyKey único)
    if (error.code === 11000 && error.message.includes('idempotencyKey')) {
      log.warn('duplicate_event', 'Evento duplicado ignorado', {
        idempotencyKey,
        eventType
      });
      
      // Retorna o evento existente
      const existing = await EventStore.findOne({ idempotencyKey });
      return { ...existing.toObject(), duplicate: true };
    }

    log.error('append_error', 'Erro ao salvar evento', {
      error: error.message,
      eventType,
      aggregateId
    });
    throw error;
  }
}

/**
 * Verifica se evento já existe (idempotência)
 */
export async function eventExists(idempotencyKey) {
  if (!idempotencyKey) return false;
  return EventStore.isProcessed(idempotencyKey);
}

// ============ CONSUMER ============

/**
 * Busca eventos pendentes para processamento
 */
export async function getPendingEvents(options = {}) {
  const { limit = 100, olderThanMinutes = 1 } = options;
  
  return EventStore.findPending({ limit, olderThanMinutes });
}

/**
 * Marca evento como processado
 */
export async function markEventProcessed(eventId, workerName) {
  try {
    // Escrita legada (sem token): não pode passar por cima de uma execução
    // com posse viva de outro worker.
    const now = new Date();
    const r = await EventStore.updateOne(
      { eventId, ...notLiveOwnedFilter(now) },
      {
        $set: { status: 'processed', processedAt: now, processedBy: workerName },
        $unset: { processingToken: '', processingOwner: '', leaseExpiresAt: '' }
      }
    );
    if (r.matchedCount === 0) {
      const exists = await EventStore.exists({ eventId });
      if (!exists) {
        log.warn('mark_processed_not_found', 'Evento não encontrado', { eventId });
      } else {
        log.warn('mark_processed_owned_by_other', 'Evento com posse viva de outra execução; conclusão sem token ignorada', { eventId, workerName });
      }
      return null;
    }

    log.debug('event_processed', 'Evento marcado como processado', {
      eventId,
      workerName
    });

    return EventStore.findOne({ eventId }).lean();
  } catch (error) {
    log.error('mark_processed_error', 'Erro ao marcar evento', {
      error: error.message,
      eventId
    });
    throw error;
  }
}

/**
 * Marca evento como falhou (escrita legada, sem token)
 */
export async function markEventFailed(eventId, error) {
  try {
    const now = new Date();
    const updated = await EventStore.findOneAndUpdate(
      { eventId, ...notLiveOwnedFilter(now) },
      {
        $inc: { attempts: 1 },
        $set: { status: 'failed', error: { message: error.message, stack: error.stack, code: error.code } },
        $unset: { processingToken: '', processingOwner: '', leaseExpiresAt: '' }
      },
      { new: true }
    ).lean();
    if (!updated) {
      log.warn('mark_failed_not_applied', 'Evento não encontrado ou com posse viva de outra execução', { eventId });
      return null;
    }

    log.debug('event_failed', 'Evento marcado como falhou', {
      eventId,
      attempts: updated.attempts,
      error: error.message
    });

    return updated;
  } catch (err) {
    log.error('mark_failed_error', 'Erro ao marcar evento como falhou', {
      error: err.message,
      eventId
    });
    throw err;
  }
}

/**
 * Marca evento como dead letter (escrita legada, sem token)
 */
export async function markEventDeadLetter(eventId, error) {
  try {
    const now = new Date();
    const updated = await EventStore.findOneAndUpdate(
      { eventId, ...notLiveOwnedFilter(now) },
      {
        $set: { status: 'dead_letter', error: { message: error.message, stack: error.stack, code: error.code } },
        $unset: { processingToken: '', processingOwner: '', leaseExpiresAt: '' }
      },
      { new: true }
    ).lean();
    if (!updated) return null;

    log.warn('event_dead_letter', 'Evento movido para dead letter', {
      eventId,
      error: error.message
    });

    return updated;
  } catch (err) {
    log.error('mark_dlq_error', 'Erro ao mover para DLQ', {
      error: err.message,
      eventId
    });
    throw err;
  }
}

// ============ REPLAY ============

/**
 * Replay de eventos de um aggregate
 * 
 * @param {string} aggregateType - Tipo do aggregate
 * @param {string} aggregateId - ID do aggregate
 * @param {Function} handler - Função para processar cada evento
 * @param {Object} options - Opções
 */
export async function replayAggregate(aggregateType, aggregateId, handler, options = {}) {
  const { fromSequence = 0 } = options;

  log.info('replay_start', 'Iniciando replay de aggregate', {
    aggregateType,
    aggregateId,
    fromSequence
  });

  try {
    const events = await EventStore.findByAggregate(
      aggregateType, 
      aggregateId, 
      { fromSequence }
    );

    log.info('replay_events_found', 'Eventos encontrados para replay', {
      count: events.length
    });

    const results = [];
    for (const event of events) {
      try {
        const result = await handler(event);
        results.push({ eventId: event.eventId, success: true, result });
      } catch (error) {
        results.push({ 
          eventId: event.eventId, 
          success: false, 
          error: error.message 
        });
        
        // Se handler pedir para parar, interrompe
        if (options.stopOnError) {
          break;
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    log.info('replay_complete', 'Replay completado', {
      total: events.length,
      success: successCount,
      failed: failCount
    });

    return {
      success: failCount === 0,
      total: events.length,
      processed: successCount,
      failed: failCount,
      results
    };

  } catch (error) {
    log.error('replay_error', 'Erro no replay', {
      error: error.message,
      aggregateType,
      aggregateId
    });
    throw error;
  }
}

/**
 * Replay de eventos por tipo
 */
export async function replayByEventType(eventType, handler, options = {}) {
  const { fromDate, toDate, limit = 1000 } = options;

  log.info('replay_by_type_start', 'Replay por tipo de evento', {
    eventType,
    fromDate,
    toDate
  });

  const query = { eventType };
  if (fromDate || toDate) {
    query.createdAt = {};
    if (fromDate) query.createdAt.$gte = new Date(fromDate);
    if (toDate) query.createdAt.$lte = new Date(toDate);
  }

  const events = await EventStore.find(query)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const results = [];
  for (const event of events) {
    try {
      const result = await handler(event);
      results.push({ eventId: event.eventId, success: true, result });
    } catch (error) {
      results.push({ 
        eventId: event.eventId, 
        success: false, 
        error: error.message 
      });
      if (options.stopOnError) break;
    }
  }

  return {
    total: events.length,
    processed: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results
  };
}

// ============ QUERIES ============

/**
 * Busca eventos por correlation ID
 */
export async function findByCorrelation(correlationId, options = {}) {
  const { limit = 100 } = options;
  
  return EventStore.find({ 'metadata.correlationId': correlationId })
    .sort({ sequenceNumber: 1, createdAt: 1 })
    .limit(limit)
    .lean();
}

/**
 * Estatísticas do Event Store
 */
export async function getStats() {
  return EventStore.getStats();
}

/**
 * Busca timeline de um aggregate (para UI)
 */
export async function getAggregateTimeline(aggregateType, aggregateId) {
  const events = await EventStore.findByAggregate(aggregateType, aggregateId);
  
  return events.map(e => ({
    id: e.eventId,
    type: e.eventType,
    timestamp: e.createdAt,
    status: e.status,
    payload: e.payload,
    sequence: e.sequenceNumber
  }));
}

// ============ LIMPEZA ============

/**
 * Limpa eventos antigos (cuidado!)
 */
export async function cleanupOldEvents(olderThanDays = 365) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  log.warn('cleanup_start', 'Iniciando limpeza de eventos antigos', {
    olderThanDays,
    cutoffDate
  });

  const result = await EventStore.deleteMany({
    createdAt: { $lt: cutoffDate },
    status: 'processed'
  });

  log.warn('cleanup_complete', 'Limpeza concluída', {
    deleted: result.deletedCount
  });

  return result;
}

// ============ WRAPPER PARA WORKERS ============

/**
 * Wrapper para processamento de eventos com garantias
 * 
 * @param {Object} event - Evento do Event Store
 * @param {Function} processor - Função de processamento
 * @param {string} workerName - Nome do worker
 */
export async function processWithGuarantees(event, processor, workerName, options = {}) {
  // Comportamento preservado: chamadores que passam só a string do eventId
  // (insuranceOrchestratorWorker) caem em eventId undefined, como antes.
  // Registrado em docs/EVENTSTORE_OWNERSHIP.md (D-1), não corrigido aqui.
  const { eventId } = event;
  const leaseMs = options.leaseMs ?? leaseMsFromEnv();
  const owner = workerName || 'unknown';

  const claim = await claimEvent(eventId, owner, { leaseMs });

  if (claim.status === 'already_processed') {
    log.info('event_already_processed', 'Evento já processado; execução ignorada', { eventId, workerName });
    return { success: true, skipped: true, reason: 'already_processed' };
  }
  if (claim.status === 'dead_letter') {
    log.warn('event_in_dead_letter', 'Evento em dead_letter; execução ignorada', { eventId, workerName });
    return { success: false, skipped: true, reason: 'dead_letter' };
  }
  if (claim.status === 'busy') {
    // Outra execução tem posse viva. Erro retentável: o BullMQ tenta de novo
    // com backoff, e a posse abandonada vence em leaseMs.
    log.warn('event_busy', 'Evento em execução por outro worker; nova tentativa depois', { eventId, workerName });
    throw new EventBusyError(eventId);
  }

  if (claim.status !== 'claimed') {
    // not_found / not_claimable: o evento não está no Event Store com estado
    // reivindicável. Mantém o caminho legado (sem posse) para não mudar o
    // comportamento de quem usa idempotencyKeys que não são eventos gravados.
    log.warn('event_ownership_unavailable', 'Execução sem posse (evento fora do Event Store ou em estado não reivindicável)', { eventId, workerName, claim: claim.status });
    return processWithoutOwnership(event, processor, workerName);
  }

  const { token } = claim;
  const keeper = startLeaseKeeper(eventId, token, {
    leaseMs,
    onLost: (err) => log.warn('event_ownership_lost', err.message, { eventId, workerName, stage: 'renew' }),
    onError: (err) => log.warn('event_lease_renew_error', 'Falha ao renovar posse; nova tentativa no próximo tique', { eventId, error: err.message })
  });

  let result;
  try {
    result = await processor(event, { signal: keeper.signal, token, eventId });
  } catch (error) {
    keeper.stop();
    const classification = classifyError(error);

    if (!classification.retryable) {
      const moved = await deadLetterOwned(eventId, token, error);
      if (!moved) {
        log.warn('event_ownership_lost', 'Posse perdida; dead letter não gravado', { eventId, workerName, stage: 'dead_letter' });
      } else {
        log.warn('event_permanent_failure', 'Erro permanente detectado, movido para dead letter', {
          eventId,
          error: error.message,
          code: error.code
        });
      }
      throw error;
    }

    const updated = await failOwned(eventId, token, error);
    if (!updated) {
      log.warn('event_ownership_lost', 'Posse perdida; falha não gravada', { eventId, workerName, stage: 'fail' });
    } else if (updated.attempts >= MAX_FAILED_ATTEMPTS) {
      // Condicional: só promove se ninguém retomou o evento nesse meio tempo.
      await EventStore.updateOne(
        { eventId, status: 'failed', attempts: { $gte: MAX_FAILED_ATTEMPTS }, processingToken: { $exists: false } },
        { $set: { status: 'dead_letter', error: { message: error.message, stack: error.stack, code: error.code } } }
      );
    }
    throw error;
  }

  keeper.stop();
  const completed = await completeOwned(eventId, token, workerName);
  if (!completed) {
    // O processador terminou, mas a posse já não era desta execução. Não
    // lança erro: relançar faria o BullMQ repetir efeitos já executados.
    log.warn('event_ownership_lost', 'Posse perdida; conclusão não gravada', { eventId, workerName, stage: 'complete' });
    return { success: false, ownershipLost: true, result };
  }
  return { success: true, result };
}

/** Caminho legado, idêntico ao anterior, para eventos sem posse possível. */
async function processWithoutOwnership(event, processor, workerName) {
  const { eventId } = event;
  try {
    const result = await processor(event, { signal: undefined, token: undefined, eventId });
    await markEventProcessed(eventId, workerName);
    return { success: true, result };
  } catch (error) {
    const classification = classifyError(error);
    if (!classification.retryable) {
      await markEventDeadLetter(eventId, error);
      throw error;
    }
    const updated = await markEventFailed(eventId, error);
    if (updated && updated.attempts >= MAX_FAILED_ATTEMPTS) {
      await markEventDeadLetter(eventId, error);
    }
    throw error;
  }
}

/**
 * Busca status de um evento pelo eventId
 * Usado pelo endpoint GET /api/v2/patients/status/:eventId
 */
export async function getEventStatus(eventId) {
  const event = await EventStore.findOne({ eventId }).lean();
  if (!event) return null;

  // Para eventos REQUEST, verifica se o evento de conclusão já existe
  const completionMap = {
    'PATIENT_CREATE_REQUESTED': 'PATIENT_CREATED',
    'PATIENT_UPDATE_REQUESTED': 'PATIENT_UPDATED',
    'PATIENT_DELETE_REQUESTED': 'PATIENT_DELETED',
  };

  const completionEventType = completionMap[event.eventType];
  if (completionEventType) {
    const completed = await EventStore.findOne({
      aggregateId: event.aggregateId,
      eventType: completionEventType,
    }).lean();

    if (completed) {
      return {
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'completed',
        payload: completed.payload,
        attempts: event.attempts,
        processedAt: completed.createdAt,
        error: null,
        createdAt: event.createdAt,
      };
    }
  }

  return {
    eventId: event.eventId,
    eventType: event.eventType,
    status: event.status,
    payload: event.payload,
    attempts: event.attempts,
    processedAt: event.processedAt,
    processedBy: event.processedBy,
    error: event.error || null,
    createdAt: event.createdAt
  };
}
