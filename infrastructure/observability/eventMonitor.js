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

    // 3. Dead letters (com detalhes)
    const deadLetterEvents = await EventStore.find({ status: 'dead_letter' })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
    if (deadLetterEvents.length > 0) {
        alerts.push({
            level: 'error',
            type: 'dead_letters',
            message: `${deadLetterEvents.length} eventos em dead letter`,
            count: deadLetterEvents.length,
            events: deadLetterEvents.map(e => ({
                eventId: e.eventId,
                eventType: e.eventType,
                aggregateType: e.aggregateType,
                aggregateId: e.aggregateId,
                errorMessage: e.error?.message || null,
                errorCode: e.error?.code || null,
                attempts: e.attempts,
                createdAt: e.createdAt
            }))
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

    // 5. APPOINTMENT_NOT_FOUND — separar temporário (race condition) vs definitivo
    const [appointmentRetryable, appointmentPermanent] = await Promise.all([
        EventStore.countDocuments({
            aggregateType: 'appointment',
            status: { $in: ['failed', 'dead_letter'] },
            'error.message': { $regex: 'NOT_READY' }
        }),
        EventStore.countDocuments({
            aggregateType: 'appointment',
            status: { $in: ['failed', 'dead_letter'] },
            'error.message': { $regex: 'NOT_FOUND_FINAL' }
        })
    ]);

    if (appointmentRetryable > 0) {
        alerts.push({
            level: 'warning',
            type: 'race_condition_detected',
            message: `${appointmentRetryable} evento(s) aguardando consistência (race condition)`,
            count: appointmentRetryable,
            category: 'retryable'
        });
    }

    if (appointmentPermanent > 0) {
        alerts.push({
            level: 'error',
            type: 'appointment_not_found',
            message: `${appointmentPermanent} evento(s) com APPOINTMENT_NOT_FOUND definitivo`,
            count: appointmentPermanent,
            category: 'permanent'
        });
    }

    // 6. Taxa de sucesso do domínio appointment
    const [aptTotal, aptProcessed] = await Promise.all([
        EventStore.countDocuments({ aggregateType: 'appointment' }),
        EventStore.countDocuments({ aggregateType: 'appointment', status: 'processed' })
    ]);

    const appointmentSuccessRate = aptTotal > 0 ? (aptProcessed / aptTotal * 100) : 0;
    if (appointmentSuccessRate < 80) {
        alerts.push({
            level: appointmentSuccessRate < 50 ? 'error' : 'warning',
            type: 'appointment_success_rate',
            message: `Taxa de sucesso de appointment baixa: ${appointmentSuccessRate.toFixed(1)}%`,
            value: appointmentSuccessRate,
            total: aptTotal,
            processed: aptProcessed
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

// ============================================
// SYSTEM HEALTH DASHBOARD (mini Datadog)
// ============================================

const healthCache = {
    lastUpdate: null,
    data: null,
    healthyTtl: 30000,   // 30s quando tudo bem
    criticalTtl: 5000    // 5s quando crítico
};

/**
 * Dashboard consolidado de saúde do sistema
 * - success rate (1h / 24h)
 * - retry rate
 * - DLQ count
 * - stuck processing
 * - throughput
 * - avg processing time
 * - top failing events
 */
export async function getSystemHealth() {
    const isCritical = healthCache.data?.status === 'critical' || healthCache.data?.status === 'warning';
    const effectiveTtl = isCritical ? healthCache.criticalTtl : healthCache.healthyTtl;

    if (healthCache.data && Date.now() - healthCache.lastUpdate < effectiveTtl) {
        return healthCache.data;
    }

    const now = new Date();
    const alerts = await getAlerts();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

    const [
        totalEvents,
        totalLastHour,
        totalLastDay,
        processedLastHour,
        processedLastDay,
        failedLastHour,
        failedLastDay,
        deadLetters,
        stuckProcessing,
        avgTime,
        topFailingEventTypes,
        domainStats,
        appointmentRetryable,
        appointmentPermanent,
        recentEvents
    ] = await Promise.all([
        EventStore.countDocuments(),
        EventStore.countDocuments({ createdAt: { $gte: oneHourAgo } }),
        EventStore.countDocuments({ createdAt: { $gte: oneDayAgo } }),
        EventStore.countDocuments({ createdAt: { $gte: oneHourAgo }, status: 'processed' }),
        EventStore.countDocuments({ createdAt: { $gte: oneDayAgo }, status: 'processed' }),
        EventStore.countDocuments({ createdAt: { $gte: oneHourAgo }, status: { $in: ['failed', 'dead_letter'] } }),
        EventStore.countDocuments({ createdAt: { $gte: oneDayAgo }, status: { $in: ['failed', 'dead_letter'] } }),
        EventStore.countDocuments({ status: 'dead_letter' }),
        EventStore.countDocuments({ status: 'processing', updatedAt: { $lte: new Date(now - 10 * 60 * 1000) } }),

        // avg processing time (last 24h)
        EventStore.aggregate([
            { $match: { status: 'processed', processedAt: { $exists: true }, createdAt: { $gte: oneDayAgo } } },
            { $project: { processingTime: { $subtract: ['$processedAt', '$createdAt'] } } },
            { $group: { _id: null, avg: { $avg: '$processingTime' }, p95: { $percentile: { p: [0.95], input: '$processingTime', method: 'approximate' } } } }
        ]),

        // top failing event types (last 24h)
        EventStore.aggregate([
            { $match: { createdAt: { $gte: oneDayAgo }, status: { $in: ['failed', 'dead_letter'] } } },
            { $group: { _id: '$eventType', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]),

        // stats by domain (last 24h)
        EventStore.aggregate([
            { $match: { createdAt: { $gte: oneDayAgo } } },
            {
                $group: {
                    _id: '$aggregateType',
                    total: { $sum: 1 },
                    processed: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
                    failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'dead_letter']] }, 1, 0] } }
                }
            }
        ]),

        // appointment consistency breakdown
        EventStore.countDocuments({
            aggregateType: 'appointment',
            status: { $in: ['failed', 'dead_letter'] },
            'error.message': { $regex: 'NOT_READY' }
        }),
        EventStore.countDocuments({
            aggregateType: 'appointment',
            status: { $in: ['failed', 'dead_letter'] },
            'error.message': { $regex: 'NOT_FOUND_FINAL' }
        }),

        // recent events (last 5 min) — limitado a 20 para não engordar payload
        EventStore.find({
            createdAt: { $gte: new Date(now - 5 * 60 * 1000) }
        })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean()
    ]);

    const successRate1h = totalLastHour > 0 ? (processedLastHour / totalLastHour * 100).toFixed(1) : 0;
    const successRate24h = totalLastDay > 0 ? (processedLastDay / totalLastDay * 100).toFixed(1) : 0;
    const errorRate1h = totalLastHour > 0 ? (failedLastHour / totalLastHour * 100).toFixed(1) : 0;
    const errorRate24h = totalLastDay > 0 ? (failedLastDay / totalLastDay * 100).toFixed(1) : 0;
    const throughputPerHour = totalLastDay / 24;

    // ── Health Score (0–100) ────────────────────────────────────────────────
    let healthScore = 100;

    // success rate (24h)
    if (successRate24h < 50) healthScore -= 30;
    else if (successRate24h < 70) healthScore -= 15;
    else if (successRate24h < 85) healthScore -= 5;

    // dead letters
    if (deadLetters >= 10) healthScore -= 25;
    else if (deadLetters >= 5) healthScore -= 15;
    else if (deadLetters > 0) healthScore -= 8;

    // stuck processing
    if (stuckProcessing >= 10) healthScore -= 20;
    else if (stuckProcessing >= 5) healthScore -= 10;
    else if (stuckProcessing > 0) healthScore -= 5;

    // error rate (1h)
    if (errorRate1h > 10) healthScore -= 20;
    else if (errorRate1h > 5) healthScore -= 10;
    else if (errorRate1h > 1) healthScore -= 3;

    // processing time
    const p95Ms = Math.round((avgTime[0]?.p95?.[0]) || 0);
    if (p95Ms > 30000) healthScore -= 10;
    else if (p95Ms > 15000) healthScore -= 5;

    // appointment race conditions / permanent failures
    if (appointmentPermanent > 0) healthScore -= 10;
    else if (appointmentRetryable > 0) healthScore -= 3;

    // failing domains
    const failingDomains = domainStats.filter(d => d.total > 0 && (d.processed / d.total) < 0.5);
    healthScore -= failingDomains.length * 5;

    healthScore = Math.max(0, Math.min(100, healthScore));

    const computedStatus = healthScore < 60 ? 'critical'
        : healthScore < 85 ? 'warning'
        : 'healthy';

    const byDomain = domainStats.reduce((acc, d) => {
        acc[d._id] = d.total;
        return acc;
    }, {});

    const byStatus = {
        processed: await EventStore.countDocuments({ status: 'processed' }),
        pending: await EventStore.countDocuments({ status: 'pending' }),
        failed: await EventStore.countDocuments({ status: 'failed' }),
        dead_letter: deadLetters,
        processing: await EventStore.countDocuments({ status: 'processing' })
    };

    const health = {
        timestamp: now.toISOString(),
        summary: {
            totalEvents,
            deadLetters,
            stuckProcessing,
            throughputPerHour: Math.round(throughputPerHour * 10) / 10
        },
        successRate: {
            last1h: Number(successRate1h),
            last24h: Number(successRate24h)
        },
        errorRate: {
            last1h: Number(errorRate1h),
            last24h: Number(errorRate24h)
        },
        processingTime: {
            avgMs: Math.round(avgTime[0]?.avg || 0),
            p95Ms: Math.round((avgTime[0]?.p95?.[0]) || 0)
        },
        topFailingEventTypes: topFailingEventTypes.map(t => ({
            eventType: t._id,
            count: t.count
        })),
        domains: domainStats.map(d => ({
            domain: d._id,
            total: d.total,
            processed: d.processed,
            failed: d.failed,
            successRate: d.total > 0 ? (d.processed / d.total * 100).toFixed(1) : 0
        })).sort((a, b) => b.total - a.total),
        appointment: {
            retryableNotFound: appointmentRetryable,
            permanentNotFound: appointmentPermanent
        },
        recentEvents: (recentEvents || []).map((e) => ({
            id: e._id,
            eventId: e.eventId,
            eventType: e.eventType,
            status: e.status,
            aggregateType: e.aggregateType,
            timestamp: e.createdAt,
            correlationId: e.metadata?.correlationId || e.correlationId
        })),
        overview: {
            totalEvents,
            lastHour: totalLastHour,
            lastDay: totalLastDay,
            errorsLastHour: failedLastHour,
            deadLetters
        },
        byStatus,
        byDomain,
        alerts,
        healthScore,
        status: computedStatus
    };

    healthCache.data = health;
    healthCache.lastUpdate = Date.now();
    return health;
}

export default {
    getEventMetrics,
    getEventFlow,
    getRecentEvents,
    getAlerts,
    getDomainHealth,
    getSystemHealth,
    clearMetricsCache
};
