/**
 * 🔍 Financial Snapshot Audit Cron
 *
 * Roda automaticamente a cada 6h e detecta divergências V1 vs V2.
 * Publica alertas se encontrar inconsistências.
 */

import cron from 'node-cron';
import moment from 'moment-timezone';
import PaymentsView from '../models/PaymentsView.js';
import FinancialDailySnapshot from '../models/FinancialDailySnapshot.js';
import { getSnapshotsForRange, reducePaymentStats } from '../services/financialSnapshot.service.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('cron', 'FinancialSnapshotAudit');
const TIMEZONE = 'America/Sao_Paulo';

const THRESHOLDS = {
  healthy: 1.0,
  warning: 3.0,
  critical: 5.0
};

function classifyDivergence(pct) {
  const abs = Math.abs(pct);
  if (abs < THRESHOLDS.healthy) return 'healthy';
  if (abs < THRESHOLDS.warning) return 'warning';
  return 'critical';
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
  return { produced: raw.produced, received: raw.received, count: raw.count, countPaid: raw.countPaid, countPartial: raw.countPartial, countPending: raw.countPending };
}

async function runAudit() {
  const today = moment().tz(TIMEZONE);
  const startDate = today.clone().startOf('month').format('YYYY-MM-DD');
  const endDate = today.format('YYYY-MM-DD');
  const clinicId = 'default';

  try {
    const [v1, v2] = await Promise.all([
      getV1Aggregate({ startDate, endDate, clinicId }),
      (async () => {
        const snapshots = await getSnapshotsForRange(startDate, endDate, clinicId);
        return reducePaymentStats(snapshots);
      })()
    ]);

    const metrics = ['produced', 'received', 'count', 'countPaid', 'countPartial', 'countPending'];
    const issues = [];

    for (const key of metrics) {
      const diff = (v2[key] || 0) - (v1[key] || 0);
      const pct = v1[key] ? (diff / v1[key]) * 100 : 0;
      const status = classifyDivergence(pct);
      if (status !== 'healthy') {
        issues.push({ metric: key, v1: v1[key], v2: v2[key], diff, percentage: Math.round(pct * 100) / 100, status });
      }
    }

    if (issues.length === 0) {
      log.info('snapshot_audit_healthy', 'Snapshot V2 consistente com V1', { startDate, endDate, v1, v2 });
      return { status: 'healthy', issues: [] };
    }

    const worstStatus = issues.some(i => i.status === 'critical') ? 'critical' : 'warning';
    log.error('snapshot_audit_divergence', `Divergência detectada: ${worstStatus}`, {
      startDate,
      endDate,
      clinicId,
      issues,
      v1,
      v2
    });

    // 🔔 TODO: integrar com alertService para Slack/WhatsApp/email
    // await alertService.send({ level: worstStatus, title: 'Divergência Financeira V1 vs V2', details: issues });

    return { status: worstStatus, issues };
  } catch (error) {
    log.error('snapshot_audit_error', error.message, { startDate, endDate, clinicId });
    return { status: 'error', error: error.message };
  }
}

export function scheduleFinancialSnapshotAudit() {
  // Roda a cada 6h: 00:00, 06:00, 12:00, 18:00
  const task = cron.schedule('0 */6 * * *', async () => {
    log.info('snapshot_audit_start', 'Iniciando auditoria automática V1 vs V2');
    await runAudit();
  }, {
    timezone: TIMEZONE,
    scheduled: false
  });

  // Também expõe execução manual
  task.runAudit = runAudit;

  return task;
}

export { runAudit };
