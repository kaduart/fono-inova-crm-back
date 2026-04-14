// infrastructure/events/eventStoreService.js
// Serviço de Event Store - Producer e Consumer de eventos

import EventStore from '../../models/EventStore.js';
import { createContextLogger } from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { classifyError } from './errorClassifier.js';

const log = createContextLogger(null, 'event_store');

// ============ PRODUCER ============

/**
 * Salva evento no Event Store (append-only)
 * 
 * @param {Object} eventData - Dados do evento
 * @returns {Promise<Object>} Evento salvo
 */
export async function appendEvent(eventData) {
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
      aggregateId: aggregateId.toString(),
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
    const event = await EventStore.findOne({ eventId });
    if (!event) {
      log.warn('mark_processed_not_found', 'Evento não encontrado', { eventId });
      return null;
    }

    await event.markProcessed(workerName);
    
    log.debug('event_processed', 'Evento marcado como processado', {
      eventId,
      workerName
    });

    return event.toObject();
  } catch (error) {
    log.error('mark_processed_error', 'Erro ao marcar evento', {
      error: error.message,
      eventId
    });
    throw error;
  }
}

/**
 * Marca evento como falhou
 */
export async function markEventFailed(eventId, error) {
  try {
    const event = await EventStore.findOne({ eventId });
    if (!event) {
      log.warn('mark_failed_not_found', 'Evento não encontrado', { eventId });
      return null;
    }

    await event.markFailed(error);
    
    log.debug('event_failed', 'Evento marcado como falhou', {
      eventId,
      attempts: event.attempts,
      error: error.message
    });

    return event.toObject();
  } catch (err) {
    log.error('mark_failed_error', 'Erro ao marcar evento como falhou', {
      error: err.message,
      eventId
    });
    throw err;
  }
}

/**
 * Marca evento como dead letter
 */
export async function markEventDeadLetter(eventId, error) {
  try {
    const event = await EventStore.findOne({ eventId });
    if (!event) return null;

    await event.markDeadLetter(error);
    
    log.warn('event_dead_letter', 'Evento movido para dead letter', {
      eventId,
      error: error.message
    });

    return event.toObject();
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
export async function processWithGuarantees(event, processor, workerName) {
  const { eventId } = event;

  try {
    // Marca como processing
    await EventStore.updateOne(
      { eventId },
      { $set: { status: 'processing' } }
    );

    // Executa processamento
    const result = await processor(event);

    // Marca como processed
    await markEventProcessed(eventId, workerName);

    return { success: true, result };

  } catch (error) {
    const classification = classifyError(error);

    if (!classification.retryable) {
      // Erro permanente: vai direto para dead letter sem retry
      await markEventDeadLetter(eventId, error);
      log.warn('event_permanent_failure', 'Erro permanente detectado, movido para dead letter', {
        eventId,
        error: error.message,
        code: error.code
      });
      throw error;
    }

    // Incrementa tentativas
    await EventStore.updateOne(
      { eventId },
      { 
        $inc: { attempts: 1 },
        $set: { 
          status: 'failed',
          'error.message': error.message,
          'error.stack': error.stack
        }
      }
    );

    // Se tentou muitas vezes, move para DLQ
    const updated = await EventStore.findOne({ eventId });
    if (updated.attempts >= 5) {
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
