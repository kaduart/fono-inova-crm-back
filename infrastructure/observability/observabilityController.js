// back/infrastructure/observability/observabilityController.js
/**
 * Observability Controller
 * 
 * Endpoints para o dashboard de operações em tempo real
 */

import {
    getEventMetrics,
    getEventFlow,
    getRecentEvents,
    getAlerts,
    getDomainHealth,
    getSystemHealth
} from './eventMonitor.js';

import {
    listDeadLetters,
    getDeadLetterById,
    retryDeadLetter,
    retryBatchDeadLetters
} from './deadLetterService.js';

/**
 * GET /api/observability/metrics
 * Métricas gerais do sistema de eventos
 */
export async function getMetricsHandler(req, res) {
    try {
        const metrics = await getEventMetrics();
        
        res.json({
            success: true,
            data: metrics
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar métricas:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar métricas',
            message: error.message
        });
    }
}

/**
 * GET /api/observability/flow/:correlationId
 * Fluxo completo de um correlationId
 */
export async function getFlowHandler(req, res) {
    try {
        const { correlationId } = req.params;
        
        const flow = await getEventFlow(correlationId);
        
        if (!flow) {
            return res.status(404).json({
                success: false,
                error: 'Fluxo não encontrado',
                message: `Nenhum evento encontrado para correlationId: ${correlationId}`
            });
        }
        
        res.json({
            success: true,
            data: flow
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar fluxo:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar fluxo',
            message: error.message
        });
    }
}

/**
 * GET /api/observability/recent
 * Eventos recentes (últimos minutos)
 */
export async function getRecentHandler(req, res) {
    try {
        const { minutes = 5, limit = 100 } = req.query;
        
        const events = await getRecentEvents(Number(minutes), Number(limit));
        
        res.json({
            success: true,
            data: events,
            count: events.length
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar eventos recentes:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar eventos',
            message: error.message
        });
    }
}

/**
 * GET /api/observability/alerts
 * Alertas e problemas ativos
 */
export async function getAlertsHandler(req, res) {
    try {
        const alerts = await getAlerts();
        
        const hasErrors = alerts.some(a => a.level === 'error');
        const hasWarnings = alerts.some(a => a.level === 'warning');
        
        res.json({
            success: true,
            data: alerts,
            summary: {
                total: alerts.length,
                errors: alerts.filter(a => a.level === 'error').length,
                warnings: alerts.filter(a => a.level === 'warning').length,
                status: hasErrors ? 'critical' : hasWarnings ? 'warning' : 'healthy'
            }
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar alertas:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar alertas',
            message: error.message
        });
    }
}

/**
 * GET /api/observability/domain/:domain
 * Saúde de um domínio específico
 */
export async function getDomainHealthHandler(req, res) {
    try {
        const { domain } = req.params;
        
        const health = await getDomainHealth(domain);
        
        res.json({
            success: true,
            data: health
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar saúde do domínio:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar saúde',
            message: error.message
        });
    }
}

/**
 * GET /api/observability/domains
 * Lista todos os domínios com métricas
 */
export async function getAllDomainsHandler(req, res) {
    try {
        // Domínios conhecidos
        const domains = ['appointment', 'patient', 'session', 'insurance_batch', 'payment'];
        
        const domainsHealth = await Promise.all(
            domains.map(async (domain) => {
                try {
                    return await getDomainHealth(domain);
                } catch (e) {
                    return {
                        domain,
                        error: 'Failed to fetch',
                        counts: { total: 0, processed: 0, failed: 0, processing: 0 },
                        successRate: 0
                    };
                }
            })
        );
        
        res.json({
            success: true,
            data: domainsHealth
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar domínios:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar domínios',
            message: error.message
        });
    }
}

/**
 * GET /api/observability/health
 * Health check geral do sistema
 */
export async function getHealthHandler(req, res) {
    try {
        const [metrics, alerts] = await Promise.all([
            getEventMetrics(),
            getAlerts()
        ]);
        
        const criticalAlerts = alerts.filter(a => a.level === 'error');
        const warningAlerts = alerts.filter(a => a.level === 'warning');
        
        // Determina status geral
        let status = 'healthy';
        if (criticalAlerts.length > 0) status = 'critical';
        else if (warningAlerts.length > 0) status = 'warning';
        
        // Taxa de erro aceitável?
        const errorRate = metrics.overview.lastHour > 0
            ? metrics.overview.errorsLastHour / metrics.overview.lastHour
            : 0;
        
        if (errorRate > 0.05) status = 'critical'; // > 5% erro
        
        res.json({
            success: true,
            data: {
                status,
                timestamp: new Date(),
                metrics: {
                    totalEvents: metrics.overview.totalEvents,
                    lastHour: metrics.overview.lastHour,
                    errorRate: (errorRate * 100).toFixed(2) + '%',
                    deadLetters: metrics.overview.deadLetters
                },
                alerts: {
                    total: alerts.length,
                    critical: criticalAlerts.length,
                    warning: warningAlerts.length
                }
            }
        });
    } catch (error) {
        console.error('[Observability] Erro no health check:', error);
        res.status(500).json({
            success: false,
            status: 'unhealthy',
            error: error.message
        });
    }
}

/**
 * GET /api/observability/system-health
 * Dashboard consolidado de saúde do sistema (mini Datadog)
 */
export async function getSystemHealthHandler(req, res) {
    try {
        const health = await getSystemHealth();
        res.json({
            success: true,
            data: health
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar system health:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar system health',
            message: error.message
        });
    }
}

/**
 * GET /api/observability/dead-letters
 * Lista eventos em dead letter com paginação e filtros
 */
export async function getDeadLettersHandler(req, res) {
    try {
        const { page, limit, aggregateType, eventType, sort, order } = req.query;

        const result = await listDeadLetters({
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 20,
            aggregateType: aggregateType || null,
            eventType: eventType || null,
            sort: sort || 'createdAt',
            order: order || 'desc'
        });

        res.json({
            success: true,
            data: result.items,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar dead letters:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar dead letters',
            message: error.message
        });
    }
}

/**
 * GET /api/observability/dead-letters/:eventId
 * Detalhes completos de um evento em dead letter
 */
export async function getDeadLetterDetailsHandler(req, res) {
    try {
        const { eventId } = req.params;

        const event = await getDeadLetterById(eventId);

        if (!event) {
            return res.status(404).json({
                success: false,
                error: 'Dead letter não encontrado',
                message: `Nenhum evento em dead letter encontrado para eventId: ${eventId}`
            });
        }

        res.json({
            success: true,
            data: event
        });
    } catch (error) {
        console.error('[Observability] Erro ao buscar detalhes do dead letter:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar detalhes do dead letter',
            message: error.message
        });
    }
}

/**
 * POST /api/observability/dead-letters/:eventId/retry
 * Retry individual de um evento em dead letter
 */
export async function retryDeadLetterHandler(req, res) {
    try {
        const { eventId } = req.params;
        const { dryRun = false } = req.body || {};

        const result = await retryDeadLetter(eventId, { dryRun: !!dryRun });

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('[Observability] Erro ao fazer retry de dead letter:', error);
        const statusCode = error.code === 'EVENT_NOT_FOUND' || error.code === 'NO_QUEUE_MAPPED' ? 404 : 500;
        res.status(statusCode).json({
            success: false,
            error: 'Erro ao fazer retry do dead letter',
            code: error.code || 'UNKNOWN',
            message: error.message
        });
    }
}

/**
 * POST /api/observability/dead-letters/retry-batch
 * Retry em lote de eventos em dead letter
 */
export async function retryBatchDeadLettersHandler(req, res) {
    try {
        const { eventIds, aggregateType, eventType, limit, dryRun = false } = req.body || {};

        const result = await retryBatchDeadLetters({
            eventIds: Array.isArray(eventIds) ? eventIds : [],
            aggregateType: aggregateType || null,
            eventType: eventType || null,
            limit: limit ? Number(limit) : 50,
            dryRun: !!dryRun
        });

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('[Observability] Erro ao fazer retry em lote:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao fazer retry em lote',
            message: error.message
        });
    }
}
