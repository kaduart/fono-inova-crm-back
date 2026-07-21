// scripts/verificar-slot-liberado-antonella.mjs
//
// Verifica se o slot 23/07/2026 10:00 da Dra. Tatiana está liberado.

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const possibleEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'back', '.env'),
  path.resolve(process.cwd(), '..', 'back', '.env'),
];

for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não encontrado');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;

  const DOCTOR_ID = '685c2affaec14c71635863b7';
  const TARGET_DATE = '2026-07-23';
  const TARGET_TIME = '10:00';

  const doctorObjectId = new mongoose.Types.ObjectId(DOCTOR_ID);

  // A busca por data exata UTC pode falhar por timezone; usamos range de dia
  const startOfDay = new Date(`${TARGET_DATE}T00:00:00.000Z`);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const sessions = await db.collection('sessions').find({
    doctor: doctorObjectId,
    date: { $gte: startOfDay, $lt: endOfDay },
    time: TARGET_TIME,
    status: { $nin: ['canceled'] },
  }).toArray();

  const appointments = await db.collection('appointments').find({
    doctor: doctorObjectId,
    date: { $gte: startOfDay, $lt: endOfDay },
    time: TARGET_TIME,
    operationalStatus: { $nin: ['canceled', 'cancelled', 'converted', 'completed'] },
  }).toArray();

  console.log(`🎯 Slot ${TARGET_DATE} ${TARGET_TIME} com Tatiana:`);
  console.log(`  Sessões ativas: ${sessions.length}`);
  sessions.forEach((s) => console.log(`    - ${s._id} | patient=${s.patient} | status=${s.status}`));
  console.log(`  Agendamentos ativos: ${appointments.length}`);
  appointments.forEach((a) => console.log(`    - ${a._id} | patient=${a.patientName || a.patient} | status=${a.operationalStatus}`));

  if (sessions.length === 0 && appointments.length === 0) {
    console.log('\n✅ Slot está liberado.');
  } else {
    console.log('\n⚠️ Slot ainda possui ocupantes.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
