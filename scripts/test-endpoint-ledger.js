#!/usr/bin/env node
/**
 * 🧪 Testa o endpoint /api/patients/:patientId/sessions com READ layer V3
 */

import mongoose from 'mongoose';
import express from 'express';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

// Simular request
const app = express();
app.use(express.json());

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  
  console.log('🧪 Testando endpoint com READ layer V3...\n');
  
  // Buscar um paciente que tenha packages com sessions
  const patient = await db.collection('patients').findOne({});
  if (!patient) {
    console.log('❌ Nenhum paciente encontrado');
    await mongoose.disconnect();
    return;
  }
  
  const patientId = patient._id.toString();
  console.log(`👤 Paciente: ${patient.nome || patient.name || 'N/A'} (${patientId})`);
  
  // Importar o route e simular request
  const { default: patientRoute } = await import('../routes/patient.js');
  
  // Mock req/res
  const req = {
    params: { patientId },
    user: { _id: new mongoose.Types.ObjectId() }
  };
  
  let responseData = null;
  const res = {
    json: (data) => { responseData = data; },
    status: () => ({ json: (data) => { responseData = data; } })
  };
  
  // Encontrar o handler correto
  const routeLayer = patientRoute.stack.find(l => 
    l.route && l.route.path === '/:patientId/sessions' && l.route.methods.get
  );
  
  if (!routeLayer) {
    console.log('❌ Route não encontrado');
    await mongoose.disconnect();
    return;
  }
  
  const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;
  await handler(req, res);
  
  if (!responseData || !responseData.success) {
    console.log('❌ Erro na resposta:', responseData);
    await mongoose.disconnect();
    return;
  }
  
  console.log(`📦 Packages encontrados: ${responseData.data.length}`);
  
  let totalSessions = 0;
  let sessionsWithLedger = 0;
  let sessionsWithLegacy = 0;
  
  for (const pkg of responseData.data) {
    console.log(`\n  📦 ${pkg._id} | ${pkg.sessionType} | totalPaid: R$ ${pkg.totalPaid}`);
    for (const session of pkg.sessions || []) {
      totalSessions++;
      const hasLedger = session._financialSource === 'ledger_derived';
      const hasLegacy = session.isPaid !== undefined || session.paymentStatus !== undefined;
      
      if (hasLedger) sessionsWithLedger++;
      if (hasLegacy) sessionsWithLegacy++;
      
      console.log(`    Session ${session._id}: isPaid=${session.isPaid} | paymentStatus=${session.paymentStatus} | source=${session._financialSource || 'legacy'} | paymentAmount=${session._paymentAmount || 0}`);
    }
  }
  
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log('RESUMO:');
  console.log(`  Total sessions: ${totalSessions}`);
  console.log(`  Com ledger (V3): ${sessionsWithLedger}`);
  console.log(`  Com legacy (V1): ${sessionsWithLegacy}`);
  console.log(`  ${sessionsWithLedger === totalSessions ? '🟢 TODAS normalizadas pelo ledger' : '🟡 Parcialmente normalizado'}`);
  
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
