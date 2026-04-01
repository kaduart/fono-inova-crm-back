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
    getHealthHandler
} from './observabilityController.js';

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

// Fluxo por correlationId
router.get('/flow/:correlationId', getFlowHandler);

export default router;
