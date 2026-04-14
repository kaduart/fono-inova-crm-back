/**
 * 🔍 Financial Audit Routes — V2
 *
 * Compara V1 (aggregate direto) vs V2 (snapshot) e detecta divergências.
 * Prioridade máxima para governança de dados financeiros.
 */

import express from 'express';
import moment from 'moment-timezone';
import PaymentsView from '../../models/PaymentsView.js';
import FinancialDailySnapshot from '../../models/FinancialDailySnapshot.js';
import { getSnapshotsForRange, reducePaymentStats } from '../../services/financialSnapshot.service.js';
import { createContextLogger } from '../../utils/logger.js';

const router = express.Router();
const log = createContextLogger(null, 'FinancialAudit');
const TIMEZONE = 'America/Sao_Paulo';

// Thresholds de divergência (%)
const THRESHOLDS = {
  healthy: 1.0,    // < 1% = saudável
  warning: 3.0,    // 1–3% = atenção
  critical: 5.0    // > 5% = incidente
};

function classifyDivergence(pct) {
  const abs = Math.abs(pct);
  if (abs < THRESHOLDS.healthy) return 'healthy';
  if (abs < THRESHOLDS.warning) return 'warning';
  return 'critical';
}

function computeDiff(v1, v2) {
  const diff = {
    produced: (v2.produced || 0) - (v1.produced || 0),
    received: (v2.received || 0) - (v1.received || 0),
    count: (v2.count || 0) - (v1.count || 0),
    countPaid: (v2.countPaid || 0) - (v1.countPaid || 0),
    countPartial: (v2.countPartial || 0) - (v1.countPartial || 0),
    countPending: (v2.countPending || 0) - (v1.countPending || 0),
  };

  const percentage = {
    produced: v1.produced ? (diff.produced / v1.produced) * 100 : 0,
    received: v1.received ? (diff.received / v1.received) * 100 : 0,
    count: v1.count ? (diff.count / v1.count) * 100 : 0,
    countPaid: v1.countPaid ? (diff.countPaid / v1.countPaid) * 100 : 0,
    countPartial: v1.countPartial ? (diff.countPartial / v1.countPartial) * 100 : 0,
    countPending: v1.countPending ? (diff.countPending / v1.countPending) * 100 : 0,
  };

  const statuses = Object.entries(percentage).map(([key, pct]) => ({
    metric: key,
    status: classifyDivergence(pct),
    percentage: Math.round(pct * 100) / 100
  }));

  const worstStatus = statuses.some(s => s.status === 'critical')
    ? 'critical'
    : statuses.some(s => s.status === 'warning')
      ? 'warning'
      : 'healthy';

  return { diff, percentage, statuses, worstStatus };
}

async function getV1Aggregate({ startDate, endDate, clinicId }) {
  const filter = {
    createdAt: {
      $gte: moment(startDate).startOf('day').toDate(),
      $lte: moment(endDate).endOf('day').toDate(),
    },
    isDeleted: false,
  };
  if (clinicId) filter.clinicId = clinicId;

  const totals = await PaymentsView.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        produced: { $sum: '$amount' },
        received: { $sum: '$receivedAmount' },
        count: { $sum: 1 },
        countPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
        countPartial: { $sum: { $cond: [{ $eq: ['$status', 'partial'] }, 1, 0] } },
        countPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }
      }
    }
  ]);

  const raw = totals[0] || { produced: 0, received: 0, count: 0, countPaid: 0, countPartial: 0, countPending: 0 };

  return {
    produced: raw.produced,
    received: raw.received,
    count: raw.count,
    countPaid: raw.countPaid,
    countPartial: raw.countPartial,
    countPending: raw.countPending,
  };
}

async function getV2Snapshot({ startDate, endDate, clinicId }) {
  const snapshots = await getSnapshotsForRange(startDate, endDate, clinicId || null);
  return reducePaymentStats(snapshots);
}

/**
 * GET /api/v2/financial/audit
 *
 * Query params:
 * - startDate: YYYY-MM-DD (default: 1º do mês atual)
 * - endDate: YYYY-MM-DD (default: hoje)
 * - clinicId: string (default: default)
 */
router.get('/', async (req, res) => {
  try {
    const today = moment().tz(TIMEZONE);
    const startDate = req.query.startDate || today.clone().startOf('month').format('YYYY-MM-DD');
    const endDate = req.query.endDate || today.format('YYYY-MM-DD');
    const clinicId = req.query.clinicId || 'default';

    const t0 = Date.now();

    const [v1, v2] = await Promise.all([
      getV1Aggregate({ startDate, endDate, clinicId }),
      getV2Snapshot({ startDate, endDate, clinicId })
    ]);

    const { diff, percentage, statuses, worstStatus } = computeDiff(v1, v2);

    if (worstStatus !== 'healthy') {
      log.warn('financial_divergence_detected', `Status: ${worstStatus}`, {
        clinicId,
        startDate,
        endDate,
        diff,
        percentage
      });
    }

    res.json({
      success: true,
      status: worstStatus,
      thresholds: THRESHOLDS,
      period: { startDate, endDate, clinicId },
      v1,
      v2,
      diff,
      percentage,
      statuses,
      executionTimeMs: Date.now() - t0
    });
  } catch (error) {
    log.error('audit_error', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v2/financial/audit/health
 *
 * Retorna apenas se está saudável ou não (rápido para health checks)
 */
router.get('/health', async (req, res) => {
  try {
    const today = moment().tz(TIMEZONE);
    const startDate = today.clone().startOf('month').format('YYYY-MM-DD');
    const endDate = today.format('YYYY-MM-DD');
    const clinicId = req.query.clinicId || 'default';

    const [v1, v2] = await Promise.all([
      getV1Aggregate({ startDate, endDate, clinicId }),
      getV2Snapshot({ startDate, endDate, clinicId })
    ]);

    const { worstStatus, percentage } = computeDiff(v1, v2);

    res.json({
      healthy: worstStatus === 'healthy',
      status: worstStatus,
      percentage
    });
  } catch (error) {
    res.status(500).json({ healthy: false, error: error.message });
  }
});

/**
 * GET /api/v2/financial/audit/trend
 *
 * Compara dia a dia no período e mostra onde surgiu a divergência
 */
router.get('/trend', async (req, res) => {
  try {
    const today = moment().tz(TIMEZONE);
    const startDate = req.query.startDate || today.clone().subtract(7, 'days').format('YYYY-MM-DD');
    const endDate = req.query.endDate || today.format('YYYY-MM-DD');
    const clinicId = req.query.clinicId || 'default';

    const snapshots = await getSnapshotsForRange(startDate, endDate, clinicId || null);
    const days = [];

    for (const snap of snapshots) {
      const v1 = await getV1Aggregate({ startDate: snap.date, endDate: snap.date, clinicId });
      const v2 = {
        produced: snap.payments?.produced || 0,
        received: snap.payments?.received || 0,
        count: snap.payments?.count || 0,
        countPaid: snap.payments?.countPaid || 0,
      };
      const { worstStatus, diff, percentage } = computeDiff(v1, v2);
      days.push({ date: snap.date, status: worstStatus, diff, percentage });
    }

    res.json({ success: true, days });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
