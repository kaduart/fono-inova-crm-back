import express from 'express';
import { auth } from '../middleware/auth.js';
import controller from '../controllers/insuranceV2Controller.js';

const router = express.Router();

// GET /api/v2/payments/insurance/receivables
router.get('/payments/insurance/receivables', auth, controller.getInsuranceReceivables);

// POST /api/v2/financial/convenio/faturar-lote
router.post('/financial/convenio/faturar-lote', auth, controller.faturarLote);

// POST /api/v2/financial/convenio/receber-lote
router.post('/financial/convenio/receber-lote', auth, controller.receberLote);

export default router;
