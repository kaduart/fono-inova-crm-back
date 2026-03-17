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
  getCash,
  getProduction,
  getReceivable,
  getReceivableDetail
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

/**
 * GET /api/financial/v2/cash
 * 
 * Apenas caixa (recebimentos)
 */
router.get('/cash', getCash);

/**
 * GET /api/financial/v2/production
 * 
 * Apenas produção (serviços realizados)
 */
router.get('/production', getProduction);

/**
 * GET /api/financial/v2/receivable
 * 
 * Apenas contas a receber
 */
router.get('/receivable', getReceivable);
router.get('/receivable-detail', getReceivableDetail);

export default router;
