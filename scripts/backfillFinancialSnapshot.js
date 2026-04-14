#!/usr/bin/env node
/**
 * 💰 Backfill FinancialDailySnapshot
 *
 * Reprocessa PaymentsView históricos usando o MESMO worker V2.
 * Idempotente: pode rodar múltiplas vezes sem duplicar.
 *
 * Uso:
 *   node scripts/backfillFinancialSnapshot.js
 *   node scripts/backfillFinancialSnapshot.js --startDate=2026-01-01 --clinicId=default
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import PaymentsView from '../models/PaymentsView.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import { processFinancialEvent } from '../workers/financialSnapshotWorker.js';
import { createContextLogger } from '../utils/logger.js';

dotenv.config();

const log = createContextLogger('backfill', 'FinancialSnapshot');
const BATCH_SIZE = 200;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    startDate: '2024-01-01',
    endDate: moment().format('YYYY-MM-DD'),
    clinicId: 'default',
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--startDate=')) opts.startDate = arg.split('=')[1];
    if (arg.startsWith('--endDate=')) opts.endDate = arg.split('=')[1];
    if (arg.startsWith('--clinicId=')) opts.clinicId = arg.split('=')[1];
    if (arg === '--dryRun') opts.dryRun = true;
  }
  return opts;
}

const opts = parseArgs();

function normalizeMethod(method) {
  if (!method) return 'unknown';
  return method.toString().toLowerCase();
}

function normalizeCategory(category) {
  if (!category) return 'unknown';
  return category.toString().toLowerCase();
}

async function backfillPayments() {
  log.info('backfill_payments_start', 'Iniciando backfill de PaymentsView', opts);

  const filter = {
    createdAt: {
      $gte: moment(opts.startDate).startOf('day').toDate(),
      $lte: moment(opts.endDate).endOf('day').toDate(),
    },
    isDeleted: false,
  };
  if (opts.clinicId) filter.clinicId = opts.clinicId;

  let processed = 0;
  let skipped = 0;
  let page = 0;

  while (true) {
    const payments = await PaymentsView.find(filter)
      .sort({ createdAt: 1 })
      .skip(page * BATCH_SIZE)
      .limit(BATCH_SIZE)
      .lean();

    if (payments.length === 0) break;

    log.info('backfill_payments_batch', `Lote ${page + 1}`, { count: payments.length });

    for (const p of payments) {
      const eventId = `backfill-payment-${p._id}`;
      const dateStr = p.paymentDate || moment(p.createdAt).format('YYYY-MM-DD');

      const basePayload = {
        eventId,
        _id: p.paymentId || p._id,
        clinicId: p.clinicId || opts.clinicId || 'default',
        amount: p.amount || 0,
        paymentMethod: normalizeMethod(p.method),
        category: normalizeCategory(p.category),
        paymentDate: dateStr,
        status: p.status,
      };

      try {
        if (opts.dryRun) {
          log.info('dryrun_payment', 'Simulado', { eventId, status: p.status, amount: p.amount });
          processed++;
          continue;
        }

        // Reproduz o ciclo de vida do pagamento
        await processFinancialEvent('PAYMENT_PROCESS_REQUESTED', basePayload);

        if (p.status === 'paid') {
          await processFinancialEvent('PAYMENT_COMPLETED', basePayload);
        } else if (p.status === 'partial') {
          await processFinancialEvent('PAYMENT_PARTIAL', basePayload);
        } else if (['failed', 'cancelled', 'canceled'].includes(p.status)) {
          await processFinancialEvent('PAYMENT_FAILED', basePayload);
        }

        processed++;
      } catch (err) {
        log.error('backfill_payment_error', err.message, { paymentId: p._id });
        skipped++;
      }
    }

    page++;
  }

  log.info('backfill_payments_done', 'Finalizado', { processed, skipped });
  return { processed, skipped };
}

async function backfillSessions() {
  log.info('backfill_sessions_start', 'Iniciando backfill de Session.completed', opts);

  const filter = {
    status: 'completed',
    date: { $gte: opts.startDate, $lte: opts.endDate },
  };

  let processed = 0;
  let skipped = 0;
  let page = 0;

  while (true) {
    const sessions = await Session.find(filter)
      .select('date sessionValue paymentMethod package status')
      .sort({ date: 1 })
      .skip(page * BATCH_SIZE)
      .limit(BATCH_SIZE)
      .lean();

    if (sessions.length === 0) break;

    for (const s of sessions) {
      const eventId = `backfill-session-${s._id}`;
      try {
        if (opts.dryRun) {
          processed++;
          continue;
        }
        await processFinancialEvent('SESSION_COMPLETED', {
          eventId,
          _id: s._id,
          sessionId: s._id,
          clinicId: opts.clinicId || 'default',
          sessionValue: s.sessionValue,
          paymentMethod: s.paymentMethod,
          date: s.date,
        });
        processed++;
      } catch (err) {
        skipped++;
      }
    }

    page++;
  }

  log.info('backfill_sessions_done', 'Finalizado', { processed, skipped });
  return { processed, skipped };
}

async function backfillAppointments() {
  log.info('backfill_appointments_start', 'Iniciando backfill de Appointment.confirmed/pending', opts);

  const filter = {
    date: { $gte: opts.startDate, $lte: opts.endDate },
    clinicalStatus: { $nin: ['completed', 'cancelled'] },
  };

  let processedConfirmed = 0;
  let processedPending = 0;
  let skipped = 0;
  let page = 0;

  while (true) {
    const appointments = await Appointment.find(filter)
      .select('date sessionValue package paymentMethod operationalStatus clinicalStatus')
      .sort({ date: 1 })
      .skip(page * BATCH_SIZE)
      .limit(BATCH_SIZE)
      .lean();

    if (appointments.length === 0) break;

    for (const a of appointments) {
      const eventId = `backfill-appt-${a._id}`;
      try {
        if (opts.dryRun) {
          processedConfirmed++;
          continue;
        }

        const payload = {
          eventId,
          _id: a._id,
          appointmentId: a._id,
          clinicId: opts.clinicId || 'default',
          date: a.date,
          sessionValue: a.sessionValue,
          package: a.package,
          paymentMethod: a.paymentMethod,
          operationalStatus: a.operationalStatus,
          clinicalStatus: a.clinicalStatus,
        };

        if (['confirmed', 'scheduled'].includes(a.operationalStatus)) {
          await processFinancialEvent('APPOINTMENT_CONFIRMED', payload);
          processedConfirmed++;
        } else if (a.operationalStatus === 'pending') {
          await processFinancialEvent('APPOINTMENT_PENDING', payload);
          processedPending++;
        }
      } catch (err) {
        skipped++;
      }
    }

    page++;
  }

  log.info('backfill_appointments_done', 'Finalizado', { processedConfirmed, processedPending, skipped });
  return { processedConfirmed, processedPending, skipped };
}

async function validateBackfill() {
  const { default: FinancialDailySnapshot } = await import('../models/FinancialDailySnapshot.js');

  const snapshotAgg = await FinancialDailySnapshot.aggregate([
    { $match: { date: { $gte: opts.startDate, $lte: opts.endDate } } },
    {
      $group: {
        _id: null,
        totalPaymentsProduced: { $sum: '$payments.produced' },
        totalPaymentsReceived: { $sum: '$payments.received' },
        totalPaymentsCount: { $sum: '$payments.count' },
        totalProduction: { $sum: '$production.total' },
        totalScheduled: { $sum: '$scheduled.total' },
        snapshotDays: { $sum: 1 },
      }
    }
  ]);

  const snapshotStats = snapshotAgg[0] || {};

  // V1 reference
  const v1Payments = await PaymentsView.aggregate([
    {
      $match: {
        createdAt: {
          $gte: moment(opts.startDate).startOf('day').toDate(),
          $lte: moment(opts.endDate).endOf('day').toDate(),
        },
        isDeleted: false,
        clinicId: opts.clinicId || { $exists: true },
      }
    },
    {
      $group: {
        _id: null,
        produced: { $sum: '$amount' },
        received: { $sum: '$receivedAmount' },
        count: { $sum: 1 },
      }
    }
  ]);

  const v1Stats = v1Payments[0] || { produced: 0, received: 0, count: 0 };

  log.info('validation_report', 'Comparação V1 vs Snapshot', {
    payments: {
      v1Produced: v1Stats.produced,
      snapshotProduced: snapshotStats.totalPaymentsProduced || 0,
      v1Received: v1Stats.received,
      snapshotReceived: snapshotStats.totalPaymentsReceived || 0,
      v1Count: v1Stats.count,
      snapshotCount: snapshotStats.totalPaymentsCount || 0,
    },
    snapshotDays: snapshotStats.snapshotDays || 0,
  });

  const diffProduced = Math.abs((v1Stats.produced || 0) - (snapshotStats.totalPaymentsProduced || 0));
  const diffReceived = Math.abs((v1Stats.received || 0) - (snapshotStats.totalPaymentsReceived || 0));
  const threshold = 1.01; // 1% de tolerância

  const isProducedOk = v1Stats.produced === 0 || diffProduced / v1Stats.produced < 0.01;
  const isReceivedOk = v1Stats.received === 0 || diffReceived / v1Stats.received < 0.01;

  if (!isProducedOk || !isReceivedOk) {
    log.error('validation_failed', 'Divergência detectada entre V1 e Snapshot', { diffProduced, diffReceived });
  } else {
    log.info('validation_passed', 'Snapshot consistente com V1');
  }
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI não configurado');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  log.info('mongo_connected', 'Conectado ao MongoDB');

  const t0 = Date.now();

  await backfillPayments();
  await backfillSessions();
  await backfillAppointments();
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
