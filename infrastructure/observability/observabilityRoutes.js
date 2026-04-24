// back/infrastructure/observability/observabilityRoutes.js
/**
 * Rotas para Observabilidade
 */

import { Router } from 'express';
import {
    getMetricsHandler,
    getFlowHandler,
    getRecentHandler,
    getAlertsHandler,
    getDomainHealthHandler,
    getAllDomainsHandler,
    getHealthHandler,
    getSystemHealthHandler,
    getDeadLettersHandler,
    getDeadLetterDetailsHandler,
    retryDeadLetterHandler,
    retryBatchDeadLettersHandler
} from './observabilityController.js';
import { auth, authorize } from '../../middleware/auth.js';
import { getQueue } from '../queue/queueConfig.js';

const router = Router();

// Health check geral
router.get('/health', getHealthHandler);

// 🛡️ Health check do WhatsApp — 3 estados: healthy | warning | critical
router.get('/whatsapp-health', async (req, res) => {
    try {
        const checks = {
            workersEnabled: process.env.ENABLE_WORKERS === 'true',
            redisConnected: false,
            inboundQueueOk: false,
            persistenceQueueOk: false,
            pendingEventsCritical: 0,
            pendingEventsWarning: 0,
            recentFailures: 0
        };

        // Testar filas
        try {
            const inboundQ = getQueue('whatsapp-inbound');
            const persistenceQ = getQueue('whatsapp-persistence');
            const [inboundCounts, persistenceCounts] = await Promise.all([
                inboundQ.getJobCounts(),
                persistenceQ.getJobCounts()
            ]);
            checks.redisConnected = true;
            checks.inboundQueueOk = (inboundCounts.waiting || 0) < 50;
            checks.persistenceQueueOk = (persistenceCounts.waiting || 0) < 50;
            checks.inboundCounts = inboundCounts;
            checks.persistenceCounts = persistenceCounts;
        } catch (e) {
            checks.redisError = e.message;
        }

        // Verificar eventos pendentes
        const EventStore = (await import('../../models/EventStore.js')).default;
        const now = new Date();
        const twoMinAgo = new Date(now - 2 * 60_000);
        const fiveMinAgo = new Date(now - 5 * 60_000);

        checks.pendingEventsWarning = await EventStore.countDocuments({
            eventType: 'WHATSAPP_MESSAGE_RECEIVED',
            status: 'pending',
            createdAt: { $lte: twoMinAgo }
        });
        checks.pendingEventsCritical = await EventStore.countDocuments({
            eventType: 'WHATSAPP_MESSAGE_RECEIVED',
            status: 'pending',
            createdAt: { $lte: fiveMinAgo }
        });
        checks.recentFailures = await EventStore.countDocuments({
            eventType: { $in: ['WHATSAPP_MESSAGE_RECEIVED', 'WHATSAPP_MESSAGE_PREPROCESSED'] },
            status: { $in: ['failed', 'dead_letter'] },
            updatedAt: { $gte: new Date(now - 60 * 60_000) }
        });

        // Determinar status
        let status = 'healthy';
        let statusCode = 200;

        // CRITICAL: workers off, redis down, backlog grave, ou pendentes > 5min
        if (!checks.workersEnabled || !checks.redisConnected ||
            !checks.inboundQueueOk || !checks.persistenceQueueOk ||
            checks.pendingEventsCritical > 0) {
            status = 'critical';
            statusCode = 503;
        }
        // WARNING: workers OK mas backlog leve ou pendentes 2-5min
        else if (checks.pendingEventsWarning > 0) {
            status = 'warning';
            statusCode = 200; // não quebra health check, mas sinaliza
        }

        res.status(statusCode).json({
            success: status === 'healthy',
            status,
            timestamp: new Date().toISOString(),
            checks
        });
    } catch (error) {
        console.error('[WhatsAppHealth] Erro:', error);
        res.status(503).json({
            success: false,
            status: 'error',
            error: error.message
        });
    }
});

// Métricas gerais
router.get('/metrics', getMetricsHandler);

// Eventos recentes
router.get('/recent', getRecentHandler);

// Alertas
router.get('/alerts', getAlertsHandler);

// Domínios
router.get('/domains', getAllDomainsHandler);
router.get('/domain/:domain', getDomainHealthHandler);

// System Health Dashboard
router.get('/system-health', getSystemHealthHandler);

// Fluxo por correlationId
router.get('/flow/:correlationId', getFlowHandler);

// Dead Letters - inspeção detalhada e retry
router.get('/dead-letters', getDeadLettersHandler);
router.get('/dead-letters/:eventId', getDeadLetterDetailsHandler);
router.post('/dead-letters/:eventId/retry', auth, authorize(['admin']), retryDeadLetterHandler);
router.post('/dead-letters/retry-batch', auth, authorize(['admin']), retryBatchDeadLettersHandler);

export default router;
