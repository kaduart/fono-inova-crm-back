// back/scripts/migrations/revert-appointment-payment-embedded-corruption.js
//
// Reverte corrupção onde `appointment.payment` foi transformado em sub-documento
// (ex: { _id, amount, paymentMethod, status }) em vez de ObjectId.
//
// O schema de Appointment define `payment` como:
//   payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }
//
// Esta migração é ESTRITAMENTE estrutural: converte `object → ObjectId`, preservando
// a referência ao payment. NÃO altera paymentStatus, isPaid, updatedAt ou qualquer
// outro campo financeiro/operacional.
//
// Uso:
//   node scripts/migrations/revert-appointment-payment-embedded-corruption.js --dry-run
//   node scripts/migrations/revert-appointment-payment-embedded-corruption.js --execute
//   node scripts/migrations/revert-appointment-payment-embedded-corruption.js --report > report.json

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const isDryRun = process.argv.includes('--dry-run');
const isExecute = process.argv.includes('--execute');
const isReport = process.argv.includes('--report');

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI não definida');
  process.exit(1);
}

if (!isDryRun && !isExecute && !isReport) {
  console.error('❌ Informe --dry-run, --execute ou --report');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const appointments = db.collection('appointments');

  // Filtro estrito: apenas BSON type 3 (object) e que tenham _id
  const filter = {
    payment: { $exists: true, $ne: null, $type: 3 },
    'payment._id': { $exists: true }
  };

  const cursor = appointments.find(filter);
  let total = 0;
  let updated = 0;
  let skippedNoId = 0;
  let skippedInvalidId = 0;
  let skippedMissingPayment = 0;
  const diffs = [];

  console.error(`[modo=${isExecute ? 'EXECUTE' : isReport ? 'REPORT' : 'DRY-RUN'}] Iniciando reversão de payment embedded...`);

  for await (const appt of cursor) {
    total++;
    const rawPayment = appt.payment;

    // Dupla validação na hora: deve ser objeto com _id válido
    if (typeof rawPayment !== 'object' || rawPayment === null || !rawPayment._id) {
      skippedNoId++;
      console.error(`⚠️  Appointment ${appt._id} payment sem _id:`, rawPayment);
      continue;
    }

    let paymentId = rawPayment._id;
    if (typeof paymentId === 'string' && /^[a-f0-9]{24}$/i.test(paymentId)) {
      paymentId = new mongoose.Types.ObjectId(paymentId);
    }

    const paymentIdStr = paymentId?.toString?.();
    const isValidObjectId = mongoose.Types.ObjectId.isValid(paymentIdStr) && paymentIdStr?.length === 24;

    if (!isValidObjectId) {
      skippedInvalidId++;
      console.error(`⚠️  Appointment ${appt._id} payment._id inválido:`, rawPayment);
      continue;
    }

    // Validação final: payment correspondente deve existir
    const paymentDoc = await db.collection('payments').findOne(
      { _id: paymentId },
      { projection: { _id: 1, status: 1, kind: 1, canceledReason: 1 } }
    );

    if (!paymentDoc) {
      skippedMissingPayment++;
      console.error(`⚠️  Appointment ${appt._id} aponta para payment inexistente: ${paymentIdStr}`);
      continue;
    }

    const diff = {
      appointmentId: appt._id.toString(),
      before: rawPayment,
      after: paymentIdStr,
      paymentStatusReal: paymentDoc.status,
      paymentKind: paymentDoc.kind,
      paymentCanceledReason: paymentDoc.canceledReason,
    };

    diffs.push(diff);

    if (isExecute) {
      // Update MÍNIMO: apenas corrige o tipo do campo payment
      await appointments.updateOne(
        { _id: appt._id },
        { $set: { payment: paymentId } }
      );
      updated++;
      console.error(`✅ Appointment ${appt._id} → payment ${paymentIdStr}`);
    } else if (isReport) {
      // silencioso, saída será JSON no final
    } else {
      updated++;
      console.error(`[DRY-RUN] Appointment ${appt._id} → payment ${paymentIdStr}`);
    }
  }

  const summary = {
    total,
    updated,
    skippedNoId,
    skippedInvalidId,
    skippedMissingPayment,
    diffs,
  };

  if (isReport) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error('\n=== RESUMO ===');
    console.error(`Total encontrados:              ${total}`);
    console.error(`Atualizados/OK:                 ${updated}`);
    console.error(`Ignorados (sem _id):            ${skippedNoId}`);
    console.error(`Ignorados (_id inválido):       ${skippedInvalidId}`);
    console.error(`Ignorados (payment inexistente): ${skippedMissingPayment}`);
    console.error(`Modo:                           ${isExecute ? 'EXECUTE' : 'DRY-RUN'}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
