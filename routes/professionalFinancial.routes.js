/**
 * 👨‍⚕️ Professional Financial Routes
 *
 * Centro de Resultado do Profissional.
 */

import express from 'express';
import { auth, authorize } from '../middleware/auth.js';
import {
  getProfessionalSummary,
  getProfessionalPatientsBreakdown,
  getProfessionalRanking,
  getCommissionAudit,
  getCommissionSessions
} from '../services/professionalFinancial.service.js';
import {
  createAdvance,
  cancelAdvance,
  getDoctorAdvances
} from '../services/professionalAdvance.service.js';
import {
  previewSettlement,
  closeMonthlySettlement,
  getDoctorSettlements,
  getSettlement,
  cancelSettlement
} from '../services/professionalSettlement.service.js';
import {
  getDoctorCommissionRules,
  createCommissionRule,
  updateCommissionRule,
  deleteCommissionRule,
  simulateCommission
} from '../services/commissionRule.service.js';

const router = express.Router();

function parseQuery(req) {
  const { startDate, endDate } = req.query;
  return { startDate, endDate };
}

function handleError(res, error) {
  console.error('[ProfessionalFinancialRoutes]', error);
  res.status(500).json({
    success: false,
    errorCode: error.code || 'PROFESSIONAL_FINANCIAL_ERROR',
    message: error.message || 'Erro ao carregar resultado do profissional',
    ...(error.issues && { issues: error.issues })
  });
}

/**
 * GET /api/v2/professionals/:id/summary
 */
router.get('/:id/summary', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getProfessionalSummary({
      doctorId: req.params.id,
      startDate,
      endDate
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/v2/professionals/:id/patients-breakdown
 */
router.get('/:id/patients-breakdown', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getProfessionalPatientsBreakdown({
      doctorId: req.params.id,
      startDate,
      endDate
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/v2/professionals/ranking
 */
router.get('/ranking', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getProfessionalRanking({ startDate, endDate });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/v2/professionals/:id/commission-audit
 */
router.get('/:id/commission-audit', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getCommissionAudit({
      doctorId: req.params.id,
      startDate,
      endDate
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/v2/professionals/:id/commission-sessions
 */
router.get('/:id/commission-sessions', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    const result = await getCommissionSessions({
      doctorId: req.params.id,
      startDate,
      endDate
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

// ── COMMISSION RULES ──

/**
 * GET /api/v2/professionals/:id/commission-rules
 */
router.get('/:id/commission-rules', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const result = await getDoctorCommissionRules(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/v2/professionals/:id/commission-rules
 */
router.post('/:id/commission-rules', auth, authorize(['admin']), async (req, res) => {
  try {
    const result = await createCommissionRule(req.params.id, req.body);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PATCH /api/v2/professionals/:id/commission-rules/:ruleId
 */
router.patch('/:id/commission-rules/:ruleId', auth, authorize(['admin']), async (req, res) => {
  try {
    const result = await updateCommissionRule(req.params.id, req.params.ruleId, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * DELETE /api/v2/professionals/:id/commission-rules/:ruleId
 */
router.delete('/:id/commission-rules/:ruleId', auth, authorize(['admin']), async (req, res) => {
  try {
    const result = await deleteCommissionRule(req.params.id, req.params.ruleId);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/v2/professionals/:id/commission-simulation
 *
 * Simula comissão de um profissional em um período.
 */
router.get('/:id/commission-simulation', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { startDate, endDate } = parseQuery(req);
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        errorCode: 'MISSING_PERIOD',
        message: 'Informe startDate e endDate'
      });
    }
    const result = await simulateCommission(req.params.id, startDate, endDate);
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

// ── ADVANCES ──

/**
 * GET /api/v2/professionals/:id/advances
 */
router.get('/:id/advances', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { startDate, endDate, status, type } = req.query;
    const result = await getDoctorAdvances({
      doctorId: req.params.id,
      startDate,
      endDate,
      status,
      type
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/v2/professionals/:id/advances
 */
router.post('/:id/advances', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { amount, date, type, notes } = req.body;
    const result = await createAdvance({
      doctorId: req.params.id,
      amount,
      date,
      type,
      notes,
      createdBy: req.user?.id
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PATCH /api/v2/professionals/:id/advances/:advanceId/cancel
 */
router.patch('/:id/advances/:advanceId/cancel', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await cancelAdvance({
      advanceId: req.params.advanceId,
      cancelledBy: req.user?.id,
      cancelReason: reason
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

// ── SETTLEMENTS ──

/**
 * GET /api/v2/professionals/:id/settlements
 */
router.get('/:id/settlements', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { limit, status } = req.query;
    const result = await getDoctorSettlements(req.params.id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      status
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/v2/professionals/:id/settlements/:period
 */
router.get('/:id/settlements/:year/:month', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const result = await getSettlement(
      req.params.id,
      parseInt(req.params.month, 10),
      parseInt(req.params.year, 10)
    );
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/v2/professionals/:id/settlements/preview
 */
router.get('/:id/settlements/preview', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) {
      return res.status(400).json({
        success: false,
        errorCode: 'MISSING_PERIOD',
        message: 'Informe month e year'
      });
    }
    const result = await previewSettlement({
      doctorId: req.params.id,
      periodMonth: parseInt(month, 10),
      periodYear: parseInt(year, 10)
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/v2/professionals/:id/settlements/close
 */
router.post('/:id/settlements/close', auth, authorize(['admin']), async (req, res) => {
  try {
    const { month, year, force, notes } = req.body;
    if (!month || !year) {
      return res.status(400).json({
        success: false,
        errorCode: 'MISSING_PERIOD',
        message: 'Informe month e year'
      });
    }
    const result = await closeMonthlySettlement({
      doctorId: req.params.id,
      periodMonth: parseInt(month, 10),
      periodYear: parseInt(year, 10),
      closedBy: req.user?.id,
      force: force === true,
      notes
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PATCH /api/v2/professionals/:id/settlements/:year/:month/cancel
 */
router.patch('/:id/settlements/:year/:month/cancel', auth, authorize(['admin']), async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await cancelSettlement({
      doctorId: req.params.id,
      periodMonth: parseInt(req.params.month, 10),
      periodYear: parseInt(req.params.year, 10),
      cancelledBy: req.user?.id,
      reason
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
