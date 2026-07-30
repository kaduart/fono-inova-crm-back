// back/scripts/migrations/audit-insurance-batch-orphan-refs.js
//
// Investigação read-only de INSURANCE_BATCH_ORPHAN_REF.
//
// Verifica todos os InsuranceBatch.sessions[] e reporta quando:
// - session.payment aponta para Payment inexistente
// - session.session aponta para Session inexistente
//
// Coleta metadados para classificação por padrão.
//
// Uso:
//   node scripts/migrations/audit-insurance-batch-orphan-refs.js

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const jsonOnly = process.argv.includes('--json-only');

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI/MONGO_URI não definida');
  process.exit(1);
}

function log(...args) {
  if (!jsonOnly) console.log(...args);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const batches = db.collection('insurancebatches');
  const payments = db.collection('payments');
  const sessions = db.collection('sessions');
  const appointments = db.collection('appointments');

  const allBatches = await batches.find({}).toArray();

  const orphanPayments = [];
  const orphanSessions = [];
  let totalSessionEntries = 0;

  for (const batch of allBatches) {
    for (const entry of batch.sessions || []) {
      totalSessionEntries++;

      if (entry.payment) {
        const paymentExists = await payments.findOne({ _id: entry.payment }, { projection: { _id: 1, status: 1, kind: 1 } });
        if (!paymentExists) {
          // Procura outros payments para a mesma session/appointment
          const sessionPayments = entry.session
            ? await payments.find({ session: entry.session }, { projection: { _id: 1, status: 1, kind: 1, amount: 1 } }).toArray()
            : [];
          const appointmentPayments = entry.appointment
            ? await payments.find({ appointment: entry.appointment }, { projection: { _id: 1, status: 1, kind: 1, amount: 1 } }).toArray()
            : [];

          // Evita duplicatas entre sessionPayments e appointmentPayments
          const seen = new Set(sessionPayments.map(p => p._id.toString()));
          const otherPayments = [
            ...sessionPayments,
            ...appointmentPayments.filter(p => !seen.has(p._id.toString()))
          ];

          orphanPayments.push({
            batchId: batch._id.toString(),
            batchNumber: batch.batchNumber,
            batchStatus: batch.status,
            batchCreatedAt: batch.createdAt,
            batchUpdatedAt: batch.updatedAt,
            batchStartDate: batch.startDate,
            batchEndDate: batch.endDate,
            entrySessionId: entry.session?.toString?.(),
            entryAppointmentId: entry.appointment?.toString?.(),
            entryGuideId: entry.guide?.toString?.(),
            entryStatus: entry.status,
            entryGrossAmount: entry.grossAmount,
            entrySessionDate: entry.sessionDate,
            missingPaymentId: entry.payment.toString(),
            otherPaymentsForSessionOrAppointment: otherPayments.map(p => ({
              paymentId: p._id.toString(),
              status: p.status,
              kind: p.kind,
              amount: p.amount,
            })),
            hasOtherActivePayment: otherPayments.some(p => !['canceled', 'cancelled', 'refunded'].includes(p.status)),
          });
        }
      }

      if (entry.session) {
        const sessionExists = await sessions.findOne({ _id: entry.session }, { projection: { _id: 1, status: 1, appointmentId: 1, paymentId: 1, billingBatchId: 1 } });
        if (!sessionExists) {
          const appointment = entry.appointment
            ? await appointments.findOne({ _id: entry.appointment }, { projection: { _id: 1, operationalStatus: 1, paymentStatus: 1, isPaid: 1, session: 1 } })
            : null;

          orphanSessions.push({
            batchId: batch._id.toString(),
            batchNumber: batch.batchNumber,
            batchStatus: batch.status,
            batchCreatedAt: batch.createdAt,
            batchUpdatedAt: batch.updatedAt,
            entryAppointmentId: entry.appointment?.toString?.(),
            entryGuideId: entry.guide?.toString?.(),
            entryPaymentId: entry.payment?.toString?.(),
            entryStatus: entry.status,
            entryGrossAmount: entry.grossAmount,
            entrySessionDate: entry.sessionDate,
            missingSessionId: entry.session.toString(),
            appointmentExists: !!appointment,
            appointmentOperationalStatus: appointment?.operationalStatus,
            appointmentPaymentStatus: appointment?.paymentStatus,
            appointmentIsPaid: appointment?.isPaid,
            appointmentCurrentSession: appointment?.session?.toString?.(),
          });
        }
      }
    }
  }

  // Estatísticas
  const byBatchStatus = {};
  const byEntryStatus = {};
  const byYear = {};
  const byHasOtherActivePayment = { true: 0, false: 0 };

  for (const o of orphanPayments) {
    byBatchStatus[o.batchStatus] = (byBatchStatus[o.batchStatus] || 0) + 1;
    byEntryStatus[o.entryStatus] = (byEntryStatus[o.entryStatus] || 0) + 1;
    const year = o.batchCreatedAt ? new Date(o.batchCreatedAt).getFullYear() : 'unknown';
    byYear[year] = (byYear[year] || 0) + 1;
    byHasOtherActivePayment[o.hasOtherActivePayment]++;
  }

  for (const o of orphanSessions) {
    byBatchStatus[o.batchStatus] = (byBatchStatus[o.batchStatus] || 0) + 1;
    byEntryStatus[o.entryStatus] = (byEntryStatus[o.entryStatus] || 0) + 1;
    const year = o.batchCreatedAt ? new Date(o.batchCreatedAt).getFullYear() : 'unknown';
    byYear[year] = (byYear[year] || 0) + 1;
  }

  const orphanPaymentsByBatch = orphanPayments.reduce((acc, o) => {
    acc[o.batchNumber] = (acc[o.batchNumber] || 0) + 1;
    return acc;
  }, {});

  const orphanSessionsByBatch = orphanSessions.reduce((acc, o) => {
    acc[o.batchNumber] = (acc[o.batchNumber] || 0) + 1;
    return acc;
  }, {});

  log('=== INSURANCE_BATCH_ORPHAN_REF — INVESTIGAÇÃO ===');
  log(`Total de batches:             ${allBatches.length}`);
  log(`Total de session entries:       ${totalSessionEntries}`);
  log(`Payments órfãos:                ${orphanPayments.length}`);
  log(`Sessions órfãs:                 ${orphanSessions.length}`);
  log(`Total de issues:                ${orphanPayments.length + orphanSessions.length}`);
  log('\n=== POR STATUS DO BATCH ===');
  log(JSON.stringify(byBatchStatus, null, 2));
  log('\n=== POR STATUS DA ENTRY ===');
  log(JSON.stringify(byEntryStatus, null, 2));
  log('\n=== POR ANO DE CRIAÇÃO DO BATCH ===');
  log(JSON.stringify(byYear, null, 2));
  log('\n=== PAYMENT ÓRFÃO TEM OUTRO PAYMENT ATIVO? ===');
  log(JSON.stringify(byHasOtherActivePayment, null, 2));

  log('\n=== PAYMENTS ÓRFÃOS POR BATCH ===');
  log(JSON.stringify(orphanPaymentsByBatch, null, 2));

  log('\n=== SESSIONS ÓRFÃS POR BATCH ===');
  log(JSON.stringify(orphanSessionsByBatch, null, 2));

  if (jsonOnly) {
    console.log(JSON.stringify({ orphanPayments, orphanSessions }, null, 2));
  } else {
    log('\n=== AMOSTRA DE PAYMENTS ÓRFÃOS (primeiros 10) ===');
    log(JSON.stringify(orphanPayments.slice(0, 10), null, 2));

    log('\n=== AMOSTRA DE SESSIONS ÓRFÃS (primeiros 10) ===');
    log(JSON.stringify(orphanSessions.slice(0, 10), null, 2));
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
