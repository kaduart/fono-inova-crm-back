// back/scripts/migrations/audit-appointment-payment-type.js
//
// Valida o tipo real do campo appointment.payment no MongoDB.
// O schema espera ObjectId (BSON type 7), mas pode haver documentos onde
// payment virou sub-documento (BSON type 3) devido a writes com $set de
// caminhos aninhados.
//
// Uso:
//   node scripts/migrations/audit-appointment-payment-type.js
//
// Saída:
//   JSON com amostra de documentos afetados e estatísticas.

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI/MONGO_URI não definida');
  process.exit(1);
}

const SAMPLE_SIZE = 20;

function getBsonTypeName(typeCode) {
  const map = {
    1: 'double',
    2: 'string',
    3: 'object',
    4: 'array',
    5: 'binData',
    7: 'objectId',
    8: 'bool',
    9: 'date',
    10: 'null',
    16: 'int',
    18: 'long',
    19: 'decimal',
  };
  return map[typeCode] || `type_${typeCode}`;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const appointments = db.collection('appointments');

  const stats = await appointments.aggregate([
    {
      $match: {
        payment: { $exists: true, $ne: null },
      },
    },
    {
      $project: {
        paymentType: { $type: '$payment' },
      },
    },
    {
      $group: {
        _id: '$paymentType',
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  console.log('=== ESTATÍSTICAS POR TIPO BSON DE appointment.payment ===');
  let totalObject = 0;
  let totalObjectId = 0;
  for (const s of stats) {
    console.log(`  ${s._id}: ${s.count}`);
    if (s._id === 'object') totalObject = s.count;
    if (s._id === 'objectId') totalObjectId = s.count;
  }
  console.log(`\nTotal com payment preenchido: ${stats.reduce((a, s) => a + s.count, 0)}`);

  // Amostra detalhada dos casos objeto
  const objectSamples = await appointments
    .find({ payment: { $type: 3 } })
    .limit(SAMPLE_SIZE)
    .toArray();

  const detailedSamples = [];
  for (const appt of objectSamples) {
    const rawPayment = appt.payment;
    const paymentIdStr = rawPayment?._id?.toString?.() || rawPayment?.toString?.();
    const isValidObjectId = /^[a-f0-9]{24}$/i.test(paymentIdStr);

    let paymentExists = false;
    let paymentStatus = null;
    let paymentKind = null;
    let paymentCanceledReason = null;
    if (isValidObjectId) {
      const paymentDoc = await db.collection('payments').findOne(
        { _id: new mongoose.Types.ObjectId(paymentIdStr) },
        { projection: { status: 1, kind: 1, canceledReason: 1 } }
      );
      if (paymentDoc) {
        paymentExists = true;
        paymentStatus = paymentDoc.status;
        paymentKind = paymentDoc.kind;
        paymentCanceledReason = paymentDoc.canceledReason;
      }
    }

    const lastHistoryEntry = appt.history?.[appt.history.length - 1] || null;

    detailedSamples.push({
      appointmentId: appt._id.toString(),
      operationalStatus: appt.operationalStatus,
      paymentStatus: appt.paymentStatus,
      isPaid: appt.isPaid,
      billingType: appt.billingType,
      paymentMethod: appt.paymentMethod,
      paymentOrigin: appt.paymentOrigin,
      paymentBsonType: 'object',
      paymentStoredValue: rawPayment,
      extractedPaymentId: paymentIdStr,
      extractedPaymentIdValid: isValidObjectId,
      paymentExists,
      paymentStatusReal: paymentStatus,
      paymentKind,
      paymentCanceledReason,
      package: appt.package,
      session: appt.session,
      insuranceGuide: appt.insuranceGuide,
      liminarContract: appt.liminarContract,
      createdAt: appt.createdAt,
      updatedAt: appt.updatedAt,
      lastHistoryEntry,
    });
  }

  console.log(`\n=== AMOSTRA DETALHADA (${Math.min(SAMPLE_SIZE, totalObject)} de ${totalObject}) ===`);
  console.log(JSON.stringify(detailedSamples, null, 2));

  // Estatísticas de divergência dos subdocumentos
  if (totalObject > 0) {
    const allObjects = await appointments
      .find({ payment: { $type: 3 } }, { projection: { payment: 1 } })
      .toArray();

    let embeddedPaidRealCanceled = 0;
    let embeddedPaidRealOther = 0;
    let embeddedCanceledRealCanceled = 0;
    let embeddedCanceledRealOther = 0;
    let embeddedOther = 0;

    for (const appt of allObjects) {
      const raw = appt.payment;
      const idStr = raw?._id?.toString?.() || raw?.toString?.();
      if (!/^[a-f0-9]{24}$/i.test(idStr)) {
        embeddedOther++;
        continue;
      }
      const paymentDoc = await db.collection('payments').findOne(
        { _id: new mongoose.Types.ObjectId(idStr) },
        { projection: { status: 1 } }
      );
      const embeddedStatus = raw.status;
      const realStatus = paymentDoc?.status || 'MISSING';

      if (embeddedStatus === 'paid' && realStatus === 'canceled') embeddedPaidRealCanceled++;
      else if (embeddedStatus === 'paid') embeddedPaidRealOther++;
      else if (embeddedStatus === 'canceled' && realStatus === 'canceled') embeddedCanceledRealCanceled++;
      else if (embeddedStatus === 'canceled') embeddedCanceledRealOther++;
      else embeddedOther++;
    }

    console.log('\n=== DIVERGÊNCIA EMBEDDED vs PAYMENT REAL ===');
    console.log(`  embedded=paid / real=canceled:     ${embeddedPaidRealCanceled}`);
    console.log(`  embedded=paid / real=outro:        ${embeddedPaidRealOther}`);
    console.log(`  embedded=canceled / real=canceled: ${embeddedCanceledRealCanceled}`);
    console.log(`  embedded=canceled / real=outro:      ${embeddedCanceledRealOther}`);
    console.log(`  outros/inválidos:                  ${embeddedOther}`);
  }

  // Casos de pagamento inexistente
  if (totalObject > SAMPLE_SIZE) {
    const allObjectIds = await appointments
      .find({ payment: { $type: 3 } }, { projection: { _id: 1, payment: 1 } })
      .toArray();

    const missingPayments = [];
    for (const appt of allObjectIds) {
      const raw = appt.payment;
      const idStr = raw?._id?.toString?.() || raw?.toString?.();
      if (!/^[a-f0-9]{24}$/i.test(idStr)) continue;
      const exists = await db.collection('payments').findOne(
        { _id: new mongoose.Types.ObjectId(idStr) },
        { projection: { _id: 1 } }
      );
      if (!exists) {
        missingPayments.push({
          appointmentId: appt._id.toString(),
          extractedPaymentId: idStr,
        });
      }
    }

    console.log(`\n=== PAYMENTS INEXISTENTES (${missingPayments.length}) ===`);
    console.log(JSON.stringify(missingPayments.slice(0, 20), null, 2));
    if (missingPayments.length > 20) {
      console.log(`... e mais ${missingPayments.length - 20}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
