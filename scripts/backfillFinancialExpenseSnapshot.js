#!/usr/bin/env node
/**
 * 💸 Backfill FinancialDailyExpenseSnapshot
 *
 * Reprocessa Expenses e Sessions usando o financialExpenseWorker.
 * Idempotente: pode rodar múltiplas vezes.
 *
 * Uso:
 *   node scripts/backfillFinancialExpenseSnapshot.js
 *   node scripts/backfillFinancialExpenseSnapshot.js --startDate=2026-01-01 --clinicId=default
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import Expense from '../models/Expense.js';
import Session from '../models/Session.js';
import '../models/PatientsView.js';
import '../models/Patient.js';
import '../models/InsuranceGuide.js';
import { processExpenseEvent } from '../workers/financialExpenseWorker.js';
import { createContextLogger } from '../utils/logger.js';

dotenv.config();

const log = createContextLogger('backfill', 'FinancialExpenseSnapshot');
const BATCH_SIZE = 200;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    startDate: '2024-01-01',
    endDate: moment().format('YYYY-MM-DD'),
    clinicId: 'default',
    dryRun: false,
    clear: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--startDate=')) opts.startDate = arg.split('=')[1];
    if (arg.startsWith('--endDate=')) opts.endDate = arg.split('=')[1];
    if (arg.startsWith('--clinicId=')) opts.clinicId = arg.split('=')[1];
    if (arg === '--dryRun') opts.dryRun = true;
    if (arg === '--clear') opts.clear = true;
  }
  return opts;
}

const opts = parseArgs();

async function backfillExpenses() {
  log.info('backfill_expenses_start', 'Iniciando backfill de Expenses', opts);

  const filter = {
    date: { $gte: opts.startDate, $lte: opts.endDate },
    status: { $nin: ['canceled', 'cancelado'] },
  };

  let processed = 0;
  let skipped = 0;
  let page = 0;

  while (true) {
    const expenses = await Expense.find(filter)
      .sort({ date: 1 })
      .skip(page * BATCH_SIZE)
      .limit(BATCH_SIZE)
      .lean();

    if (expenses.length === 0) break;

    for (const e of expenses) {
      const eventId = `backfill-expense-${e._id}`;
      try {
        if (opts.dryRun) {
          processed++;
          continue;
        }
        await processExpenseEvent('EXPENSE_CREATED', {
          eventId,
          _id: e._id,
          expenseId: e._id,
          clinicId: opts.clinicId || 'default',
          date: e.date,
          amount: e.amount,
          expenseType: e.type,
          expenseCategory: e.category,
          doctor: e.doctor,
        });
        processed++;
      } catch (err) {
        log.error('backfill_expense_error', err.message, { expenseId: e._id });
        skipped++;
      }
    }

    page++;
  }

  log.info('backfill_expenses_done', 'Finalizado', { processed, skipped });
  return { processed, skipped };
}

async function backfillSessions() {
  log.info('backfill_sessions_commission_start', 'Iniciando backfill de comissão por SESSION_COMPLETED', opts);

  const startDateObj = moment(opts.startDate).startOf('day').toDate();
  const endDateObj = moment(opts.endDate).endOf('day').toDate();

  const filter = {
    status: 'completed',
    date: { $gte: startDateObj, $lte: endDateObj },
  };

  let processed = 0;
  let skipped = 0;
  let page = 0;

  while (true) {
    const sessions = await Session.find(filter)
      .select('date sessionValue paymentMethod package status doctor paymentOrigin sessionType serviceType insuranceGuide')
      .populate('package', 'sessionType insuranceProvider')
      .sort({ date: 1 })
      .skip(page * BATCH_SIZE)
      .limit(BATCH_SIZE)
      .lean();

    if (sessions.length === 0) break;

    for (const s of sessions) {
      const eventId = `backfill-expense-session-${s._id}`;
      try {
        if (opts.dryRun) {
          processed++;
          continue;
        }
        await processExpenseEvent('SESSION_COMPLETED', {
          eventId,
          _id: s._id,
          sessionId: s._id,
          clinicId: opts.clinicId || 'default',
          sessionValue: s.sessionValue,
          paymentMethod: s.paymentMethod,
          date: s.date,
          doctor: s.doctor,
          paymentOrigin: s.paymentOrigin,
          sessionType: s.sessionType,
          serviceType: s.serviceType,
          insuranceGuide: s.insuranceGuide,
          package: s.package,
        });
        processed++;
      } catch (err) {
        log.error('backfill_session_commission_error', err.message, { sessionId: s._id });
        skipped++;
      }
    }

    page++;
  }

  log.info('backfill_sessions_commission_done', 'Finalizado', { processed, skipped });
  return { processed, skipped };
}

async function validateBackfill() {
  const { default: FinancialDailyExpenseSnapshot } = await import('../models/FinancialDailyExpenseSnapshot.js');

  const snapshotAgg = await FinancialDailyExpenseSnapshot.aggregate([
    { $match: { date: { $gte: opts.startDate, $lte: opts.endDate } } },
    {
      $group: {
        _id: null,
        totalExpenses: { $sum: '$expenses.total' },
        totalCommission: { $sum: '$expenses.byType.commission' },
        snapshotDays: { $sum: 1 },
      }
    }
  ]);

  const snapshotStats = snapshotAgg[0] || {};

  log.info('validation_report', 'Resumo do Expense Snapshot', {
    totalExpenses: snapshotStats.totalExpenses || 0,
    totalCommission: snapshotStats.totalCommission || 0,
    snapshotDays: snapshotStats.snapshotDays || 0,
  });
}

async function clearSnapshots() {
  const { default: FinancialDailyExpenseSnapshot } = await import('../models/FinancialDailyExpenseSnapshot.js');
  log.info('clear_snapshots_start', 'Limpando expense snapshots do período', opts);
  const result = await FinancialDailyExpenseSnapshot.deleteMany({
    date: { $gte: opts.startDate, $lte: opts.endDate },
    clinicId: opts.clinicId || 'default'
  });
  log.info('clear_snapshots_done', 'Snapshots removidos', { deleted: result.deletedCount });
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI não configurado');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  log.info('mongo_connected', 'Conectado ao MongoDB');

  const t0 = Date.now();

  if (opts.clear) {
    await clearSnapshots();
  }

  await backfillExpenses();
  await backfillSessions();
  await validateBackfill();

  const duration = ((Date.now() - t0) / 1000).toFixed(1);
  log.info('backfill_complete', `Backfill finalizado em ${duration}s`, opts);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  log.error('backfill_fatal', err.message);
  process.exit(1);
});
