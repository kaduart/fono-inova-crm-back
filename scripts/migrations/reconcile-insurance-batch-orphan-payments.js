// back/scripts/migrations/reconcile-insurance-batch-orphan-payments.js
//
// PR D.2 — Reconcilia payments órfãos em InsuranceBatch.
//
// Caso: o batch aponta para um Payment que não existe mais, mas existe um outro
// Payment ativo (não cancelado/refunded) para a mesma Session/Appointment.
//
// Ação: atualiza `InsuranceBatch.sessions[].payment` para o Payment ativo.
//
// Uso:
//   node scripts/migrations/reconcile-insurance-batch-orphan-payments.js --dry-run
//   node scripts/migrations/reconcile-insurance-batch-orphan-payments.js --execute

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const isDryRun = process.argv.includes('--dry-run');
const isExecute = process.argv.includes('--execute');

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI/MONGO_URI não definida');
  process.exit(1);
}

if (!isDryRun && !isExecute) {
  console.error('❌ Informe --dry-run ou --execute');
  process.exit(1);
}

const TERMINAL_STATUSES = ['canceled', 'cancelled', 'refunded'];

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const batches = db.collection('insurancebatches');
  const payments = db.collection('payments');

  const allBatches = await batches.find({}).toArray();
  const reconciliations = [];
  let processedEntries = 0;

  console.error(`[modo=${isExecute ? 'EXECUTE' : 'DRY-RUN'}] Iniciando reconciliação de payments órfãos...`);

  for (const batch of allBatches) {
    if (!batch.sessions || batch.sessions.length === 0) continue;

    const updates = [];

    for (const entry of batch.sessions) {
      processedEntries++;
      if (!entry.payment) continue;

      const paymentExists = await payments.findOne({ _id: entry.payment }, { projection: { _id: 1 } });
      if (paymentExists) continue;

      // Busca outro payment ativo para a mesma session/appointment
      const orConditions = [];
      if (entry.session) orConditions.push({ session: entry.session });
      if (entry.appointment) orConditions.push({ appointment: entry.appointment });
      if (orConditions.length === 0) continue;

      const candidates = await payments.find({
        $or: orConditions,
        status: { $nin: TERMINAL_STATUSES }
      }, { projection: { _id: 1, status: 1, kind: 1, amount: 1, session: 1, appointment: 1 } }).toArray();

      if (candidates.length === 0) continue;

      // Preferencia por payment vinculado à session, depois appointment
      const preferred = candidates.find(p =>
        entry.session && p.session?.toString?.() === entry.session.toString()
      ) || candidates[0];

      updates.push({
        entryId: entry._id,
        oldPaymentId: entry.payment.toString(),
        newPaymentId: preferred._id.toString(),
        newPaymentStatus: preferred.status,
        newPaymentKind: preferred.kind,
        newPaymentAmount: preferred.amount,
        sessionId: entry.session?.toString?.(),
        appointmentId: entry.appointment?.toString?.(),
        batchNumber: batch.batchNumber,
        batchId: batch._id.toString(),
      });
    }

    if (updates.length === 0) continue;

    if (isExecute) {
      for (const u of updates) {
        await batches.updateOne(
          { _id: batch._id, 'sessions._id': u.entryId },
          { $set: { 'sessions.$.payment': new mongoose.Types.ObjectId(u.newPaymentId) } }
        );
      }
    }

    reconciliations.push(...updates);

    for (const u of updates) {
      console.error(`${isExecute ? '✅' : '[DRY-RUN]'} Batch ${u.batchNumber} entry ${u.entryId}: ${u.oldPaymentId} → ${u.newPaymentId}`);
    }
  }

  console.error('\n=== RESUMO ===');
  console.error(`Batches analisados:         ${allBatches.length}`);
  console.error(`Session entries analisadas: ${processedEntries}`);
  console.error(`Reconciliações ${isExecute ? 'executadas' : 'encontradas'}: ${reconciliations.length}`);

  if (!isExecute) {
    console.log(JSON.stringify(reconciliations, null, 2));
  } else {
    console.error(JSON.stringify(reconciliations, null, 2));
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
