/**
 * 🔍 Internal Financial Reconciliation Routes
 *
 * Endpoint interno para auditoria global e por profissional.
 * Apenas administradores.
 */

import express from 'express';
import { auth, authorize } from '../../../middleware/auth.js';
import {
  getGlobalReconciliation,
  getDoctorReconciliation,
  getDoctorRankingDifferences,
  getOrphanSessions,
  getOrphanPayments,
  getPatientSessionDetails,
  getTopFinancialIssues
} from '../../../services/reconciliation.service.js';
import { sendApiError } from '../../../errors/buildErrorResponse.js';
import { AppError } from '../../../errors/AppError.js';

const router = express.Router();

function parseQuery(req) {
  const { startDate, endDate, limit } = req.query;
  return {
    startDate,
    endDate,
    limit: limit ? parseInt(limit, 10) : 20
  };
}

function handleError(res, error, req) {
  console.error('[ReconciliationRoutes]', error);
  sendApiError(
    res,
    new AppError('RECONCILIATION_ERROR', error.message || 'Erro ao gerar reconciliação financeira', {
      status: 500,
    }),
    req
  );
}

/**
 * GET /api/internal/financial/reconciliation
 *
 * Retorna visão global + por profissional + classificação das divergências.
 */
router.get('/reconciliation', auth, authorize(['admin']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getGlobalReconciliation(startDate, endDate);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, req);
  }
});

/**
 * GET /api/internal/financial/reconciliation/doctors/:id
 *
 * Reconciliação por profissional com drill-down por paciente.
 */
router.get('/reconciliation/doctors/:id', auth, authorize(['admin']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getDoctorReconciliation(req.params.id, startDate, endDate);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, req);
  }
});

/**
 * GET /api/internal/financial/reconciliation/doctors/:id/patients/:patientId/sessions
 *
 * Detalhamento de sessões/pagamentos de um paciente sob um profissional.
 */
router.get('/reconciliation/doctors/:id/patients/:patientId/sessions', auth, authorize(['admin']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getPatientSessionDetails(req.params.id, req.params.patientId, startDate, endDate);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, req);
  }
});

/**
 * GET /api/internal/financial/reconciliation/doctors/ranking/differences
 */
router.get('/reconciliation/doctors/ranking/differences', auth, authorize(['admin']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getDoctorRankingDifferences(startDate, endDate);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, req);
  }
});

/**
 * GET /api/internal/financial/reconciliation/issues
 *
 * Top problemas financeiros do período.
 */
router.get('/reconciliation/issues', auth, authorize(['admin']), async (req, res) => {
  try {
    const { startDate, endDate, limit } = parseQuery(req);
    const result = await getTopFinancialIssues(startDate, endDate, limit);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, req);
  }
});

/**
 * GET /api/internal/financial/reconciliation/orphan-sessions
 */
router.get('/reconciliation/orphan-sessions', auth, authorize(['admin']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getOrphanSessions(startDate, endDate);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, req);
  }
});

/**
 * GET /api/internal/financial/reconciliation/orphan-payments
 */
router.get('/reconciliation/orphan-payments', auth, authorize(['admin']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getOrphanPayments(startDate, endDate);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, req);
  }
});

export default router;
