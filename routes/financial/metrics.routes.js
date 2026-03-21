/**
 * 💰 Financial Metrics Routes v2
 * 
 * Endpoint unificado para métricas financeiras.
 * 
 * GET /api/financial/v2/overview
 * GET /api/financial/v2/cash
 * GET /api/financial/v2/production
 * GET /api/financial/v2/receivable
 */

import express from 'express';
import { auth, authorize } from '../../middleware/auth.js';
import {
  getOverview,
  getReceivableDetail,
  getHistoricalRates
} from '../../controllers/financialMetricsController.js';

const router = express.Router();

// Todas as rotas são protegidas
router.use(auth);
router.use(authorize(['admin', 'secretary', 'financial']));

/**
 * GET /api/financial/v2/overview
 * 
 * Overview completo das 4 camadas financeiras:
 * - cash: Dinheiro efetivamente recebido
 * - production: Valor dos serviços realizados
 * - billing: Valor faturado/enviado para pagamento
 * - receivable: Valor a receber (faturado mas não pago)
 * 
 * Query params:
 * - startDate: ISO date (obrigatório)
 * - endDate: ISO date (obrigatório)
 * - includeKPIs: boolean (opcional)
 */
router.get('/overview', getOverview);

router.get('/receivable-detail', getReceivableDetail);

/**
 * GET /api/financial/v2/historical-rates
 *
 * Taxas históricas (últimos N dias) para cálculo de projeções
 * Query: ?days=90 (default: 90, range: 7-365)
 */
router.get('/historical-rates', getHistoricalRates);

export default router;
