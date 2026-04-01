// back/infrastructure/observability/eventMonitor.js
/**
 * Event Monitor
 * 
 * Sistema de observabilidade para eventos:
 * - Métricas em tempo real
 * - Tracking de fluxo por correlationId
 * - Alertas de falhas e gargalos
 * - Visualização de saúde dos domínios
 */

import EventStore from '../../models/EventStore.js';

// Cache de métricas (atualizado a cada 30s)
const metricsCache = {
    lastUpdate: null,
    data: null,
    ttl: 30000 // 30 segundos
};

// ============================================
// MÉTRICAS EM TEMPO REAL
// ============================================

/**
 * Busca métricas gerais do sistema de eventos
 */
export async function getEventMetrics() {
    // Usa cache se válido
    if (metricsCache.data && Date.now() - metricsCache.lastUpdate < metricsCache.ttl) {
        return metricsCache.data;
    }

    const now = new Date();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

    // Aggregate para métricas
    const [
        totalEvents,
        eventsByStatus,
        eventsByDomain,
        recentErrors,
        deadLetters
    ] = await Promise.all([
        // Total de eventos
        EventStore.countDocuments(),

        // Por status
        EventStore.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]),

        // Por domínio (aggregateType)
        EventStore.aggregate([
            { $group: { _id: '$aggregateType', count: { $sum: 1 } } }
        ]),

        // Erros recentes
        EventStore.countDocuments({
            status: 'failed',
            updatedAt: { $gte: oneHourAgo }
        }),

        // Eventos em dead letter
        EventStore.countDocuments({ status: 'dead_letter' })
    ]);

    // Tempo médio de processamento
    const processingTime = await EventStore.aggregate([
        {
            $match: {
                status: 'processed',
                processedAt: { $exists: true },
                createdAt: { $gte: oneDayAgo }
            }
        },
        {
            $project: {
                processingTime: { $subtract: ['$processedAt', '$createdAt'] }
            }
        },
        {
            $group: {
                _id: null,
                avgTime: { $avg: '$processingTime' },
                maxTime: { $max: '$processingTime' },
                minTime: { $min: '$processingTime' }
            }
        }
    ]);

    const metrics = {
        timestamp: now,
        overview: {
            totalEvents,
            lastHour: await EventStore.countDocuments({ createdAt: { $gte: oneHourAgo } }),
            lastDay: await EventStore.countDocuments({ createdAt: { $gte: oneDayAgo } }),
            errorsLastHour: recentErrors,
            deadLetters
        },
        byStatus: eventsByStatus.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
        }, {}),
        byDomain: eventsByDomain.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
        }, {}),
        processingTime: processingTime[0] || { avgTime: 0, maxTime: 0, minTime: 0 }
    };

    // Atualiza cache
    metricsCache.data = metrics;
    metricsCache.lastUpdate = Date.now();

    return metrics;
}

/**
 * Busca fluxo completo por correlationId
 */
export async function getEventFlow(correlationId) {
    const events = await EventStore.find({ correlationId })
        .sort({ createdAt: 1 })
        .lean();

    if (events.length === 0) {
        return null;
    }

    // Monta timeline
    const timeline = events.map(event => ({
        id: event._id,
        eventId: event.eventId,
        eventType: event.eventType,
        status: event.status,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        timestamp: event.createdAt,
        processedAt: event.processedAt,
        processingTime: event.processedAt
            ? new Date(event.processedAt) - new Date(event.createdAt)
            : null,
        errorInfo: event.errorInfo,
        metadata: event.metadata
    }));

    // Calcula estatísticas do fluxo
    const startTime = events[0].createdAt;
    const endTime = events[events.length - 1].processedAt || events[events.length - 1].createdAt;
    const totalTime = new Date(endTime) - new Date(startTime);

    // Verifica se há falhas
    const hasErrors = events.some(e => e.status === 'failed' || e.status === 'dead_letter');

    // Identifica domínios envolvidos
    const domains = [...new Set(events.map(e => e.aggregateType))];

    return {
        correlationId,
        summary: {
            totalEvents: events.length,
            duration: totalTime,
            hasErrors,
            domains,
            startTime,
            endTime
        },
        timeline
    };
}

/**
 * Busca eventos em tempo real (últimos N minutos)
 */
export async function getRecentEvents(minutes = 5, limit = 100) {
    const since = new Date(Date.now() - minutes * 60 * 1000);

    const events = await EventStore.find({
        createdAt: { $gte: since }
    })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    return events.map(e => ({
        id: e._id,
        eventId: e.eventId,
        eventType: e.eventType,
        status: e.status,
        aggregateType: e.aggregateType,
        correlationId: e.correlationId,
        timestamp: e.createdAt,
        retryCount: e.errorInfo?.retryCount || 0
    }));
}

/**
 * Busca alertas e problemas
 */
export async function getAlerts() {
    const now = new Date();
    const alerts = [];

    // 1. Eventos falhos nas últimas horas
    const recentFailures = await EventStore.find({
        status: 'failed',
        updatedAt: { $gte: new Date(now - 2 * 60 * 60 * 1000) }
    }).limit(10);

    if (recentFailures.length > 0) {
        alerts.push({
            level: 'warning',
            type: 'recent_failures',
            message: `${recentFailures.length} eventos falhos nas últimas 2 horas`,
            count: recentFailures.length,
            events: recentFailures.map(e => ({
                eventId: e.eventId,
                eventType: e.eventType,
                errorMessage: e.errorInfo?.errorMessage
            }))
        });
    }

    // 2. Eventos presos em processing há muito tempo (> 10 min)
    const stuckEvents = await EventStore.find({
        status: 'processing',
        updatedAt: { $lte: new Date(now - 10 * 60 * 1000) }
    }).limit(10);

    if (stuckEvents.length > 0) {
        alerts.push({
            level: 'error',
            type: 'stuck_events',
            message: `${stuckEvents.length} eventos presos em processamento`,
            count: stuckEvents.length,
            events: stuckEvents.map(e => ({
                eventId: e.eventId,
                eventType: e.eventType,
                stuckSince: e.updatedAt
            }))
        });
    }

    // 3. Dead letters
    const deadLetters = await EventStore.countDocuments({ status: 'dead_letter' });
    if (deadLetters > 0) {
        alerts.push({
            level: 'error',
            type: 'dead_letters',
            message: `${deadLetters} eventos em dead letter`,
            count: deadLetters
        });
    }

    // 4. Taxa de erro alta (> 10% nas últimas horas)
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const [total, failed] = await Promise.all([
        EventStore.countDocuments({ createdAt: { $gte: oneHourAgo } }),
        EventStore.countDocuments({
            createdAt: { $gte: oneHourAgo },
            status: { $in: ['failed', 'dead_letter'] }
        })
    ]);

    if (total > 0 && failed / total > 0.1) {
        alerts.push({
            level: 'error',
            type: 'high_error_rate',
            message: `Taxa de erro alta: ${(failed / total * 100).toFixed(1)}%`,
            rate: failed / total,
            total,
            failed
        });
    }

    return alerts;
}

/**
 * Busca métricas por domínio
 */
export async function getDomainHealth(domain) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [
        total,
        processed,
        failed,
        processing
    ] = await Promise.all([
        EventStore.countDocuments({ aggregateType: domain }),
        EventStore.countDocuments({ aggregateType: domain, status: 'processed' }),
        EventStore.countDocuments({ aggregateType: domain, status: 'failed' }),
        EventStore.countDocuments({ aggregateType: domain, status: 'processing' })
    ]);

    const avgTime = await EventStore.aggregate([
        {
            $match: {
                aggregateType: domain,
                status: 'processed',
                processedAt: { $exists: true }
            }
        },
        {
            $project: {
                processingTime: { $subtract: ['$processedAt', '$createdAt'] }
            }
        },
        {
            $group: {
                _id: null,
                avg: { $avg: '$processingTime' }
            }
        }
    ]);

    const recentEvents = await EventStore.find({
        aggregateType: domain,
        createdAt: { $gte: oneHourAgo }
    })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

    return {
        domain,
        counts: { total, processed, failed, processing },
        successRate: total > 0 ? (processed / total * 100).toFixed(1) : 0,
        avgProcessingTime: avgTime[0]?.avg || 0,
        recentEvents: recentEvents.map(e => ({
            eventType: e.eventType,
            status: e.status,
            timestamp: e.createdAt
        }))
    };
}

/**
 * Limpa cache de métricas
 */
export function clearMetricsCache() {
    metricsCache.data = null;
    metricsCache.lastUpdate = null;
}

// Auto-limpar cache a cada 5 minutos
setInterval(clearMetricsCache, 5 * 60 * 1000);

export default {
    getEventMetrics,
    getEventFlow,
    getRecentEvents,
    getAlerts,
    getDomainHealth,
    clearMetricsCache
};
