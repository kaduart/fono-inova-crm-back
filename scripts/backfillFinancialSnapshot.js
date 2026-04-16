#!/usr/bin/env node
/**
 * 💰 Backfill FinancialDailySnapshot
 *
 * Reprocessa Payment e Session históricos usando o MESMO worker V2.
 * Idempotente: pode rodar múltiplas vezes sem duplicar.
 *
 * Uso:
 *   node scripts/backfillFinancialSnapshot.js
 *   node scripts/backfillFinancialSnapshot.js --startDate=2026-01-01 --clinicId=default
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';
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

function normalizeMethod(method) {
  if (!method) return 'unknown';
  return method.toString().toLowerCase();
}

function normalizeCategory(category) {
  if (!category) return 'unknown';
  return category.toString().toLowerCase();
}

async function backfillPayments() {
  log.info('backfill_payments_start', 'Iniciando backfill de Payment (fonte de verdade V2)', opts);

  // Fallback: se paymentDate for nulo/vazio, usa createdAt via $or
  const fallbackFilter = {
    $or: [
      { paymentDate: { $gte: opts.startDate, $lte: opts.endDate } },
      {
        $or: [{ paymentDate: { $exists: false } }, { paymentDate: null }, { paymentDate: '' }],
        createdAt: {
          $gte: moment(opts.startDate).startOf('day').toDate(),
          $lte: moment(opts.endDate).endOf('day').toDate(),
        },
        status: { $nin: ['canceled', 'cancelado'] },
      }
    ]
  };

  let processed = 0;
  let skipped = 0;
  let page = 0;

  while (true) {
    const payments = await Payment.find(fallbackFilter)
      .select('paymentDate billingType insurance.receivedAmount amount paymentMethod status notes description type serviceType doctor createdAt')
      .sort({ paymentDate: 1, createdAt: 1 })
      .skip(page * BATCH_SIZE)
      .limit(BATCH_SIZE)
      .lean();

    if (payments.length === 0) break;

    log.info('backfill_payments_batch', `Lote ${page + 1}`, { count: payments.length });

    for (const p of payments) {
      const dateStr = p.paymentDate || moment(p.createdAt).format('YYYY-MM-DD');

      const basePayload = {
        _id: p._id,
        paymentId: p._id,
        clinicId: opts.clinicId || 'default',
        amount: p.amount || 0,
        paymentMethod: normalizeMethod(p.paymentMethod),
        billingType: p.billingType,
        category: normalizeCategory(p.type),
        paymentDate: dateStr,
        status: p.status,
        notes: p.notes,
        description: p.description,
        type: p.type,
        serviceType: p.serviceType,
        doctor: p.doctor,
      };

      try {
        if (!p.paymentDate) {
          log.warn('payment_without_paymentDate', 'Pagamento sem paymentDate - usando fallback createdAt', { paymentId: p._id, createdAt: p.createdAt });
        }

        if (opts.dryRun) {
          processed++;
          continue;
        }

        // Reproduz o ciclo de vida do pagamento
        // Cada estágio TEM eventId diferente pra não ser bloqueado pela idempotência
        await processFinancialEvent('PAYMENT_PROCESS_REQUESTED', {
          ...basePayload,
          eventId: `backfill-payment-req-${p._id}`,
        });

        if (p.status === 'paid') {
          await processFinancialEvent('PAYMENT_COMPLETED', {
            ...basePayload,
            eventId: `backfill-payment-comp-${p._id}`,
          });
        } else if (p.status === 'partial') {
          await processFinancialEvent('PAYMENT_PARTIAL', {
            ...basePayload,
            eventId: `backfill-payment-part-${p._id}`,
          });
        } else if (['failed', 'cancelled', 'canceled'].includes(p.status)) {
          await processFinancialEvent('PAYMENT_FAILED', {
            ...basePayload,
            eventId: `backfill-payment-fail-${p._id}`,
          });
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
      .select('date sessionValue paymentMethod package status doctor paymentOrigin')
      .populate('package', 'insuranceGrossAmount sessionValue sessionType')
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
          doctor: s.doctor,
          paymentOrigin: s.paymentOrigin,
          package: s.package,
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

  const startDateObj = moment(opts.startDate).startOf('day').toDate();
  const endDateObj = moment(opts.endDate).endOf('day').toDate();

  const filter = {
    date: { $gte: startDateObj, $lte: endDateObj },
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

async function clearSnapshots() {
  const { default: FinancialDailySnapshot } = await import('../models/FinancialDailySnapshot.js');
  log.info('clear_snapshots_start', 'Limpando snapshots do período', opts);
  const result = await FinancialDailySnapshot.deleteMany({
    date: { $gte: opts.startDate, $lte: opts.endDate },
    clinicId: opts.clinicId || 'default'
  });
  log.info('clear_snapshots_done', 'Snapshots removidos', { deleted: result.deletedCount });
}

async function validateBackfill() {
  const { default: FinancialDailySnapshot } = await import('../models/FinancialDailySnapshot.js');

  const snapshotAgg = await FinancialDailySnapshot.aggregate([
    { $match: { date: { $gte: opts.startDate, $lte: opts.endDate }, clinicId: opts.clinicId || 'default' } },
    {
      $group: {
        _id: null,
        totalPaymentsProduced: { $sum: '$payments.produced' },
        totalPaymentsReceived: { $sum: '$payments.received' },
        totalPaymentsCount: { $sum: '$payments.count' },
        totalProduction: { $sum: '$production.total' },
        totalProductionCount: { $sum: '$production.count' },
        totalScheduled: { $sum: '$scheduled.total' },
        snapshotDays: { $sum: 1 },
      }
    }
  ]);

  const snapshotStats = snapshotAgg[0] || {};

  // Validação contra Payment (fonte de verdade real)
  const Payment = (await import('../models/Payment.js')).default;
  const startDateObj = moment(opts.startDate).startOf('day').toDate();
  const endDateObj = moment(opts.endDate).endOf('day').toDate();

  const [paymentStats, sessionStats] = await Promise.all([
    Payment.aggregate([
      {
        $match: {
          createdAt: { $gte: startDateObj, $lte: endDateObj },
          status: { $nin: ['canceled', 'cancelado'] }
        }
      },
      {
        $group: {
          _id: null,
          produced: { $sum: '$amount' },
          received: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
          count: { $sum: 1 },
        }
      }
    ]),
    Session.aggregate([
      {
        $match: {
          status: 'completed',
          date: { $gte: startDateObj, $lte: endDateObj }
        }
      },
      {
        $lookup: {
          from: 'packages',
          localField: 'package',
          foreignField: '_id',
          as: 'pkg'
        }
      },
      { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          production: {
            $sum: {
              $cond: [
                { $gt: ['$sessionValue', 0] },
                '$sessionValue',
                {
                  $ifNull: [
                    { $cond: [{ $gt: ['$pkg.sessionValue', 0] }, '$pkg.sessionValue', null] },
                    { $cond: [{ $gt: ['$pkg.insuranceGrossAmount', 0] }, '$pkg.insuranceGrossAmount', 0] }
                  ]
                }
              ]
            }
          },
          count: { $sum: 1 }
        }
      }
    ])
  ]);

  // Correção: comparar Payment com MESMO critério do backfill (paymentDate ou createdAt fallback)
  // IMPORTANTE: aggregate não faz cast automático de string->Date como o find() do Mongoose
  const paymentDateStart = moment(opts.startDate).startOf('day').toDate();
  const paymentDateEnd = moment(opts.endDate).endOf('day').toDate();

  const paymentDateStats = await Payment.aggregate([
    {
      $match: {
        $or: [
          {
            paymentDate: { $gte: paymentDateStart, $lte: paymentDateEnd },
            status: { $nin: ['canceled', 'cancelado'] }
          },
          {
            $or: [
              { paymentDate: { $exists: false } },
              { paymentDate: null }
            ],
            createdAt: { $gte: startDateObj, $lte: endDateObj },
            status: { $nin: ['canceled', 'cancelado'] }
          }
        ]
      }
    },
    {
      $group: {
        _id: null,
        produced: { $sum: '$amount' },
        received: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
        count: { $sum: 1 },
      }
    }
  ]);

  // Correção: comparar Session com valor real (sessionValue || package.insuranceGrossAmount)
  const sessionRealValueStats = await Session.aggregate([
    {
      $match: {
        status: 'completed',
        date: { $gte: startDateObj, $lte: endDateObj }
      }
    },
    {
      $lookup: {
        from: 'packages',
        localField: 'package',
        foreignField: '_id',
        as: 'pkg'
      }
    },
    { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: null,
        production: {
          $sum: {
            $cond: [
              { $gt: ['$sessionValue', 0] },
              '$sessionValue',
              { $ifNull: ['$pkg.insuranceGrossAmount', 0] }
            ]
          }
        },
        count: { $sum: 1 }
      }
    }
  ]);

  const sourceStats = paymentDateStats[0] || { produced: 0, received: 0, count: 0 };
  const sourceSessions = sessionRealValueStats[0] || { production: 0, count: 0 };
  const rawPaymentStats = paymentStats[0] || { produced: 0, received: 0, count: 0 };

  log.info('validation_report_payments', 'Comparação Payment (paymentDate)', {
    sourceProduced: sourceStats.produced,
    snapshotProduced: snapshotStats.totalPaymentsProduced || 0,
    producedDiff: (snapshotStats.totalPaymentsProduced || 0) - (sourceStats.produced || 0),
    sourceReceived: sourceStats.received,
    snapshotReceived: snapshotStats.totalPaymentsReceived || 0,
    receivedDiff: (snapshotStats.totalPaymentsReceived || 0) - (sourceStats.received || 0),
    sourceCount: sourceStats.count,
    snapshotCount: snapshotStats.totalPaymentsCount || 0,
    rawCreatedAtProduced: rawPaymentStats.produced,
    rawCreatedAtCount: rawPaymentStats.count,
  });

  log.info('validation_report_sessions', 'Comparação Session (valorReal)', {
    sourceProduction: sourceSessions.production,
    snapshotProduction: snapshotStats.totalProduction || 0,
    productionDiff: (snapshotStats.totalProduction || 0) - (sourceSessions.production || 0),
    sourceCount: sourceSessions.count,
    snapshotCount: snapshotStats.totalProductionCount || 0,
  });

  // Spot-check: dia com maior diferença absoluta
  const dailySnap = await FinancialDailySnapshot.aggregate([
    { $match: { date: { $gte: opts.startDate, $lte: opts.endDate }, clinicId: opts.clinicId || 'default' } },
    {
      $project: {
        date: 1,
        snapProduced: '$payments.produced',
        snapReceived: '$payments.received',
        snapProduction: '$production.total'
      }
    },
    { $sort: { date: 1 } }
  ]);

  // Para calcular maxDiffDay precisaríamos da fonte diária (mais complexo).
  // Por ora, logamos os top 5 dias de snapshot por valor total para spot-check visual.
  const topDays = dailySnap
    .map(d => ({ date: d.date, total: (d.snapProduced || 0) + (d.snapProduction || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  log.info('validation_report_meta', 'Metadados do snapshot', {
    snapshotDays: snapshotStats.snapshotDays || 0,
    topDaysByValue: topDays,
  });

  const diffProduced = Math.abs((sourceStats.produced || 0) - (snapshotStats.totalPaymentsProduced || 0));
  const diffReceived = Math.abs((sourceStats.received || 0) - (snapshotStats.totalPaymentsReceived || 0));
  const diffProduction = Math.abs((sourceSessions.production || 0) - (snapshotStats.totalProduction || 0));

  const isProducedOk = sourceStats.produced === 0 || diffProduced / sourceStats.produced < 0.01;
  const isReceivedOk = sourceStats.received === 0 || diffReceived / sourceStats.received < 0.01;
  const isProductionOk = sourceSessions.production === 0 || diffProduction / sourceSessions.production < 0.01;

  if (!isProducedOk || !isReceivedOk || !isProductionOk) {
    log.error('validation_failed', 'Divergência detectada entre fonte de verdade e Snapshot', { diffProduced, diffReceived, diffProduction });
  } else {
    log.info('validation_passed', 'Snapshot consistente com fonte de verdade');
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

  if (opts.clear) {
    await clearSnapshots();
  }

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
