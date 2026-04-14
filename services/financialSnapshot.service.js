/**
 * 💰 Financial Snapshot Service — V2 PURO
 *
 * Regra: ZERO aggregate em runtime para leitura analítica.
 * Tudo vem de FinancialDailySnapshot com reduce em memória (milissegundos).
 */

import moment from 'moment-timezone';
import FinancialDailySnapshot from '../models/FinancialDailySnapshot.js';

const TIMEZONE = 'America/Sao_Paulo';

function toDateStr(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().split('T')[0];
}

/**
 * Retorna array de snapshots para um período (inclusive)
 */
export async function getSnapshotsForRange(startDate, endDate, clinicId = null) {
  const start = typeof startDate === 'string' ? startDate : toDateStr(startDate);
  const end = typeof endDate === 'string' ? endDate : toDateStr(endDate);

  const filter = { date: { $gte: start, $lte: end } };
  filter.clinicId = clinicId || 'default';

  return FinancialDailySnapshot.find(filter).lean().sort({ date: 1 });
}

/**
 * Retorna snapshot de um mês inteiro
 */
export async function getSnapshotsForMonth(yearMonth, clinicId = null) {
  const start = `${yearMonth}-01`;
  const end = moment(start).endOf('month').format('YYYY-MM-DD');
  return getSnapshotsForRange(start, end, clinicId);
}

/**
 * Reduce de payments a partir de snapshots
 */
export function reducePaymentStats(snapshots) {
  return snapshots.reduce(
    (acc, day) => {
      const p = day.payments || {};
      acc.produced += p.produced || 0;
      acc.received += p.received || 0;
      acc.count += p.count || 0;
      acc.countPaid += p.countPaid || 0;
      acc.countPartial += p.countPartial || 0;
      acc.countPending += p.countPending || 0;

      Object.entries(p.byMethod || {}).forEach(([k, v]) => {
        acc.byMethod[k] = (acc.byMethod[k] || 0) + (v || 0);
      });
      Object.entries(p.byCategory || {}).forEach(([k, v]) => {
        acc.byCategory[k] = (acc.byCategory[k] || 0) + (v || 0);
      });

      return acc;
    },
    {
      produced: 0,
      received: 0,
      count: 0,
      countPaid: 0,
      countPartial: 0,
      countPending: 0,
      byMethod: {},
      byCategory: {},
    }
  );
}

/**
 * Reduce geral de produção + caixa + scheduled
 */
export function reduceFullStats(snapshots) {
  return snapshots.reduce(
    (acc, day) => {
      const prod = day.production || {};
      const cash = day.cash || {};
      const sched = day.scheduled || {};
      const pend = day.pending || {};
      const conv = day.convenio || {};

      acc.productionTotal += prod.total || 0;
      acc.productionCount += prod.count || 0;
      acc.cashTotal += cash.total || 0;
      acc.scheduledTotal += sched.total || 0;
      acc.scheduledCount += sched.count || 0;
      acc.pendingTotal += pend.total || 0;
      acc.pendingCount += pend.count || 0;
      acc.convenioAtendido += (conv.atendido?.total || 0);
      acc.convenioFaturado += (conv.faturado?.total || 0);
      acc.convenioRecebido += (conv.recebido?.total || 0);

      return acc;
    },
    {
      productionTotal: 0,
      productionCount: 0,
      cashTotal: 0,
      scheduledTotal: 0,
      scheduledCount: 0,
      pendingTotal: 0,
      pendingCount: 0,
      convenioAtendido: 0,
      convenioFaturado: 0,
      convenioRecebido: 0,
    }
  );
}
