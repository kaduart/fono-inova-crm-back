/**
 * 💸 Financial Expense Snapshot Service
 *
 * Agrega FinancialDailyExpenseSnapshot para ranges mensais.
 * Leitura pura — ZERO cálculo em runtime.
 */

import moment from 'moment-timezone';
import FinancialDailyExpenseSnapshot from '../models/FinancialDailyExpenseSnapshot.js';

const TIMEZONE = 'America/Sao_Paulo';

class FinancialExpenseSnapshotService {
  async getMonthlyAggregate(year, month, clinicId = 'default') {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month');
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month');
    const startStr = start.format('YYYY-MM-DD');
    const endStr = end.format('YYYY-MM-DD');

    const snapshots = await FinancialDailyExpenseSnapshot.find({
      clinicId,
      date: { $gte: startStr, $lte: endStr }
    }).lean();

    const result = {
      total: 0,
      count: snapshots.length,
      hasData: snapshots.length > 0,
      breakdown: {
        commission: 0,
        fixed: 0,
        variable: 0,
        other: 0,
      },
      detalheComissoes: [], // será preenchido pelo caller com Doctor names
      profissionais: new Map(),
    };

    for (const snap of snapshots) {
      result.total += snap.expenses?.total || 0;
      result.breakdown.commission += snap.expenses?.byType?.commission || 0;
      result.breakdown.fixed += snap.expenses?.byType?.fixed || 0;
      result.breakdown.variable += snap.expenses?.byType?.variable || 0;
      result.breakdown.other += snap.expenses?.byType?.other || 0;

      for (const prof of (snap.professionals || [])) {
        const existing = result.profissionais.get(prof.professionalId);
        if (existing) {
          existing.commission += prof.commission || 0;
          existing.commissionProvisao += prof.commissionProvisao || 0;
          existing.countSessions += prof.countSessions || 0;
        } else {
          result.profissionais.set(prof.professionalId, {
            doctorId: prof.professionalId,
            total: 0,
            sessions: 0,
            commission: prof.commission || 0,
            commissionProvisao: prof.commissionProvisao || 0,
            countSessions: prof.countSessions || 0,
          });
        }
      }
    }

    return result;
  }

  async isMonthlySnapshotReady(year, month, clinicId = 'default') {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month');
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month');
    const today = moment.tz(TIMEZONE);
    const lastDay = today.isAfter(end, 'day') ? end : today;
    const expectedDays = lastDay.diff(start, 'days') + 1;

    const startStr = start.format('YYYY-MM-DD');
    const endStr = lastDay.format('YYYY-MM-DD');

    const count = await FinancialDailyExpenseSnapshot.countDocuments({
      clinicId,
      date: { $gte: startStr, $lte: endStr }
    });

    return count / expectedDays >= 0.8;
  }
}

export default new FinancialExpenseSnapshotService();
