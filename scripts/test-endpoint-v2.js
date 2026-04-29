#!/usr/bin/env node
/**
 * 🧪 Compara V1 vs V2 do endpoint /patients/:id/sessions
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
  
  console.log('🧪 Comparando V1 vs V2 do endpoint /sessions\n');
  
  // Buscar paciente com packages
  const pkg = await db.collection('packages').findOne({});
  if (!pkg) { console.log('Sem packages'); await mongoose.disconnect(); return; }
  
  const patientId = pkg.patient.toString();
  const patient = await db.collection('patients').findOne({ _id: pkg.patient });
  console.log('👤 Paciente:', patient?.nome || patient?.name || 'N/A', '\n');
  
  // Simular V1 (documento direto)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔴 V1 — Documento direto (LEGADO)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const packagesV1 = await db.collection('packages').find({ patient: pkg.patient }).toArray();
  let totalSessionsV1 = 0;
  for (const p of packagesV1) {
    const sessions = await db.collection('sessions').find({ package: p._id }).toArray();
    for (const s of sessions) {
      totalSessionsV1++;
      console.log(`  ${s._id} | isPaid: ${s.isPaid} | paymentStatus: ${s.paymentStatus || 'undefined'}`);
    }
  }
  
  // Simular V2 (ledger)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🟢 V2 — Ledger-based (REAL)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const sessionIds = [];
  for (const p of packagesV1) {
    const sessions = await db.collection('sessions').find({ package: p._id }).toArray();
    sessionIds.push(...sessions.map(s => s._id));
  }
  
  const payments = await db.collection('payments').find({
    session: { $in: sessionIds },
    status: { $in: ['paid', 'pending'] }
  }).toArray();
  
  const paymentMap = {};
  for (const p of payments) {
    const sid = p.session?.toString();
    if (!paymentMap[sid]) paymentMap[sid] = p;
  }
  
  let totalSessionsV2 = 0;
  let divergences = 0;
  
  for (const p of packagesV1) {
    const sessions = await db.collection('sessions').find({ package: p._id }).toArray();
    for (const s of sessions) {
      totalSessionsV2++;
      const pay = paymentMap[s._id.toString()];
      const v2IsPaid = pay ? pay.status === 'paid' : false;
      const v2Status = pay ? pay.status : 'unpaid';
      const v1IsPaid = s.isPaid;
      const v1Status = s.paymentStatus || 'undefined';
      
      const match = (v1IsPaid === v2IsPaid && v1Status === v2Status) ? '✅' : '❌ DIVERGÊNCIA';
      if (match.includes('❌')) divergences++;
      
      console.log(`  ${s._id} | isPaid: ${v2IsPaid} | paymentStatus: ${v2Status} | amount: ${pay?.amount || 0} ${match}`);
    }
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('RESUMO:');
  console.log(`  Total sessions: ${totalSessionsV1}`);
  console.log(`  V1 → V2 divergências: ${divergences}`);
  console.log(`  Taxa de inconsistência: ${((divergences / totalSessionsV1) * 100).toFixed(1)}%`);
  console.log(`  ${divergences === 0 ? '🟢 Dados consistentes' : '🔴 Dados legados estão MENTINDO'}`);
  
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
