/**
 * Serviço de gerenciamento de Dead Letters do Event Store
 *
 * - Listagem detalhada de eventos em dead_letter
 * - Retry individual e em lote
 * - Dry-run para simulação
 */

import EventStore from '../../models/EventStore.js';
import { queues, eventToQueueMap } from '../events/eventPublisher.js';
import { createContextLogger } from '../../utils/logger.js';

const log = createContextLogger(null, 'dead_letter_service');

const DEFAULT_JOB_OPTIONS = {
    attempts: 5,
    backoff: {
        type: 'exponential',
        delay: 1000
    },
    removeOnComplete: {
        age: 24 * 3600,
        count: 1000
    },
    removeOnFail: {
        age: 7 * 24 * 3600
    }
};

/**
 * Lista eventos em dead letter com paginação e filtros
 */
export async function listDeadLetters(options = {}) {
    const {
        page = 1,
        limit = 20,
        aggregateType = null,
        eventType = null,
        sort = 'createdAt',
        order = 'desc'
    } = options;

    const query = { status: 'dead_letter' };
    if (aggregateType) query.aggregateType = aggregateType;
    if (eventType) query.eventType = eventType;

    const skip = (Math.max(1, Number(page)) - 1) * Math.max(1, Number(limit));
    const take = Math.max(1, Number(limit));
    const sortOrder = order === 'asc' ? 1 : -1;

    const [events, total] = await Promise.all([
        EventStore.find(query)
            .sort({ [sort]: sortOrder })
            .skip(skip)
            .limit(take)
            .lean(),
        EventStore.countDocuments(query)
    ]);

    const items = events.map(e => ({
        eventId: e.eventId,
        eventType: e.eventType,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        status: e.status,
        attempts: e.attempts,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        processedAt: e.processedAt,
        error: e.error
            ? {
                  message: e.error.message,
                  code: e.error.code,
                  stackPreview: e.error.stack
                      ? e.error.stack.split('\n').slice(0, 5).join('\n')
                      : null
              }
            : null,
        metadata: {
            correlationId: e.metadata?.correlationId || null,
            source: e.metadata?.source || null
        }
    }));

    return {
        items,
        pagination: {
            page: Math.max(1, Number(page)),
            limit: take,
            total,
            pages: Math.ceil(total / take)
        }
    };
}

/**
 * Busca detalhes completos de um evento em dead letter
 */
export async function getDeadLetterById(eventId) {
    const event = await EventStore.findOne({ eventId, status: 'dead_letter' }).lean();
    if (!event) return null;

    const mappedQueues = eventToQueueMap[event.eventType];
    const targetQueues =
        !mappedQueues || (Array.isArray(mappedQueues) && mappedQueues.length === 0)
            ? []
            : Array.isArray(mappedQueues)
              ? mappedQueues
              : [mappedQueues];

    return {
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        sequenceNumber: event.sequenceNumber,
        status: event.status,
        attempts: event.attempts,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        processedAt: event.processedAt,
        processedBy: event.processedBy,
        payload: event.payload,
        error: event.error || null,
        metadata: event.metadata || {},
        idempotencyKey: event.idempotencyKey || null,
        targetQueues
    };
}

/**
 * Retry de um evento dead letter individual
 */
export async function retryDeadLetter(eventId, options = {}) {
    const { dryRun = false } = options;

    const event = await EventStore.findOne({ eventId, status: 'dead_letter' }).lean();
    if (!event) {
        const error = new Error('Evento não encontrado ou não está em dead letter');
        error.code = 'EVENT_NOT_FOUND';
        throw error;
    }

    const queueNames = eventToQueueMap[event.eventType];
    if (!queueNames || (Array.isArray(queueNames) && queueNames.length === 0)) {
        const error = new Error(`Nenhuma fila mapeada para o eventType: ${event.eventType}`);
        error.code = 'NO_QUEUE_MAPPED';
        throw error;
    }

    const queuesToPublish = Array.isArray(queueNames) ? queueNames : [queueNames];

    if (dryRun) {
        return {
            eventId: event.eventId,
            eventType: event.eventType,
            aggregateType: event.aggregateType,
            dryRun: true,
            wouldReset: true,
            wouldAddJobs: queuesToPublish.length,
            targetQueues: queuesToPublish
        };
    }

    // 1. Resetar evento no Event Store
    await EventStore.updateOne(
        { eventId },
        {
            $set: {
                status: 'pending',
                attempts: 0,
                error: null,
                processedAt: null,
                processedBy: null
            }
        }
    );

    // 2. Reconstruir jobData e republicar nas filas
    const jobData = {
        eventId: event.eventId,
        eventType: event.eventType,
        correlationId: event.metadata?.correlationId || event.eventId,
        idempotencyKey: event.idempotencyKey,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
        publishedAt: new Date().toISOString(),
        eventStoreId: event._id?.toString?.() || null
    };

    const jobs = [];
    for (const qName of queuesToPublish) {
        const queue = queues[qName];
        if (!queue) {
            log.warn('retry_queue_missing', `Fila ${qName} não encontrada para retry`, {
                eventId,
                eventType: event.eventType
            });
            continue;
        }

        try {
            const job = await queue.add(event.eventType, jobData, DEFAULT_JOB_OPTIONS);
            jobs.push({ queue: qName, jobId: job.id });
        } catch (queueError) {
            log.error('retry_queue_error', `Erro ao adicionar job na fila ${qName}`, {
                eventId,
                error: queueError.message
            });
            jobs.push({ queue: qName, jobId: null, error: queueError.message });
        }
    }

    log.info('dead_letter_retried', 'Evento retornado para fila', {
        eventId,
        jobsAdded: jobs.filter(j => j.jobId).length,
        totalQueues: queuesToPublish.length
    });

    return {
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'pending',
        reset: true,
        jobsAdded: jobs.filter(j => j.jobId).length,
        jobs,
        targetQueues: queuesToPublish
    };
}

/**
 * Retry em lote de eventos dead letter
 */
export async function retryBatchDeadLetters(options = {}) {
    const {
        eventIds = [],
        aggregateType = null,
        eventType = null,
        limit = 50,
        dryRun = false
    } = options;

    const query = { status: 'dead_letter' };
    if (eventIds.length > 0) {
        query.eventId = { $in: eventIds };
    }
    if (aggregateType) query.aggregateType = aggregateType;
    if (eventType) query.eventType = eventType;

    const events = await EventStore.find(query)
        .limit(Math.max(1, Number(limit)))
        .lean();

    const results = [];
    let successCount = 0;
    let failedCount = 0;

    for (const event of events) {
        try {
            const result = await retryDeadLetter(event.eventId, { dryRun });
            results.push({ eventId: event.eventId, success: true, ...result });
            successCount++;
        } catch (error) {
            results.push({
                eventId: event.eventId,
                success: false,
                error: error.message,
                code: error.code || 'UNKNOWN'
            });
            failedCount++;
        }
    }

    return {
        dryRun,
        total: events.length,
        success: successCount,
        failed: failedCount,
        results
    };
}
