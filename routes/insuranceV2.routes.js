import express from 'express';
import { auth } from '../middleware/auth.js';
import controller from '../controllers/insuranceV2Controller.js';
import dashboardController from '../controllers/insuranceDashboardV2Controller.js';

const router = express.Router();

// GET /api/v2/insurance/dashboard - Funil financeiro completo
router.get('/insurance/dashboard', auth, dashboardController.getInsuranceDashboard);

// GET /api/v2/payments/insurance/receivables
router.get('/payments/insurance/receivables', auth, controller.getInsuranceReceivables);

// POST /api/v2/financial/convenio/faturar-lote
router.post('/financial/convenio/faturar-lote', auth, controller.faturarLote);

// POST /api/v2/financial/convenio/receber-lote
router.post('/financial/convenio/receber-lote', auth, controller.receberLote);

// PATCH /api/v2/insurance/session/:sessionId/bill
router.patch('/insurance/session/:sessionId/bill', auth, controller.billSession);

// PATCH /api/v2/insurance/session/:sessionId/receive
router.patch('/insurance/session/:sessionId/receive', auth, controller.receiveSession);

export default router;
