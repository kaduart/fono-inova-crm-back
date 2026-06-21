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

// GET /api/v2/insurance/guides/pending-billing
router.get('/insurance/guides/pending-billing', auth, controller.listPendingGuides);

// GET /api/v2/insurance/history - Histórico mês a mês
router.get('/insurance/history', auth, controller.getInsuranceHistory);

// GET /api/v2/insurance/patient-sessions - Sessões individuais de paciente (lazy expand)
router.get('/insurance/patient-sessions', auth, controller.getPatientInsuranceSessions);

// POST /api/v2/insurance/guides/auto-link-orphans - Vincular órfãs automaticamente
router.post('/insurance/guides/auto-link-orphans', auth, controller.autoLinkOrphanSessions);

// POST /api/v2/insurance/guides/auto-link-orphans/preview - Pré-visualizar vínculos automáticos
router.post('/insurance/guides/auto-link-orphans/preview', auth, controller.previewAutoLinkOrphanSessions);

// POST /api/v2/insurance/guides/create-from-orphan - Criar guia a partir de sessão órfã
router.post('/insurance/guides/create-from-orphan', auth, controller.createGuideFromOrphan);

// POST /api/v2/insurance/guides/link-orphan-sessions - Vincular órfãs a guia existente
router.post('/insurance/guides/link-orphan-sessions', auth, controller.linkOrphanSessionsToGuide);

export default router;
