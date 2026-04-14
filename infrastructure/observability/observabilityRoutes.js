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

const router = Router();

// Health check
router.get('/health', getHealthHandler);

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
