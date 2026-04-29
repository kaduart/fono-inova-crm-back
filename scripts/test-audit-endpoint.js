#!/usr/bin/env node
/**
 * 🧪 Testa o endpoint /api/financial/audit/summary
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('🧪 Testando endpoint /api/financial/audit/summary\n');

  // Simular a lógica do endpoint
  const totalSessions = await db.collection('sessions').countDocuments();
  const totalPayments = await db.collection('payments').countDocuments({ status: 'paid' });
  const v1PaidCount = await db.collection('sessions').countDocuments({ isPaid: true });
  const v2PaidCount = await db.collection('payments').countDocuments({
    status: 'paid',
    session: { $exists: true, $ne: null }
  });

  const falsePositives = v1PaidCount - v2PaidCount;
  const falsePositiveRate = v1PaidCount ? ((falsePositives / v1PaidCount) * 100).toFixed(1) : 0;

  const v1Revenue = await db.collection('sessions').aggregate([
    { $match: { isPaid: true } },
    { $group: { _id: null, total: { $sum: '$sessionValue' } } }
  ]).toArray();

  const v2Revenue = await db.collection('payments').aggregate([
    { $match: { status: 'paid', session: { $exists: true, $ne: null } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray();

  const v1Total = v1Revenue[0]?.total || 0;
  const v2Total = v2Revenue[0]?.total || 0;
  const revenueDelta = v1Total - v2Total;

  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  📊 AUDITORIA FINANCEIRA V1 vs V2 — RESUMO EXECUTIVO');
  console.log('══════════════════════════════════════════════════════════════════\n');

  console.log('SESSIONS:');
  console.log(`  Total no banco: ${totalSessions}`);
  console.log(`  V1 (isPaid=true): ${v1PaidCount}`);
  console.log(`  V2 (payment pago): ${v2PaidCount}`);
  console.log(`  Falsos positivos: ${falsePositives}`);
  console.log(`  Taxa de mentira: ${falsePositiveRate}%\n`);

  console.log('RECEITA:');
  console.log(`  V1 (session.isPaid): R$ ${v1Total.toFixed(2)}`);
  console.log(`  V2 (payments pagos): R$ ${v2Total.toFixed(2)}`);
  console.log(`  Delta (ilusão): R$ ${revenueDelta.toFixed(2)}`);
  console.log(`  % de ilusão: ${v1Total ? ((revenueDelta / v1Total) * 100).toFixed(1) : 0}%\n`);

  console.log('TOP 10 PACIENTES COM MAIS DIVERGÊNCIA:');
  const patientDivergences = await db.collection('sessions').aggregate([
    { $match: { isPaid: true } },
    {
      $lookup: {
        from: 'payments',
        localField: '_id',
        foreignField: 'session',
        as: 'payment'
      }
    },
    { $match: { payment: { $size: 0 } } },
    {
      $group: {
        _id: '$patient',
        falsePaidCount: { $sum: 1 },
        falseRevenue: { $sum: '$sessionValue' }
      }
    },
    { $sort: { falsePaidCount: -1 } },
    { $limit: 10 }
  ]).toArray();

  const patientIds = patientDivergences.map(p => p._id);
  const patients = await db.collection('patients').find({
    _id: { $in: patientIds }
  }, { projection: { nome: 1, name: 1 } }).toArray();

  const patientMap = {};
  for (const p of patients) {
    patientMap[p._id.toString()] = p.nome || p.name || 'N/A';
  }

  for (let i = 0; i < patientDivergences.length; i++) {
    const p = patientDivergences[i];
    console.log(`  ${i+1}. ${patientMap[p._id.toString()] || 'N/A'}`);
    console.log(`     ${p.falsePaidCount} sessões falsamente pagas | R$ ${p.falseRevenue.toFixed(2)}`);
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
