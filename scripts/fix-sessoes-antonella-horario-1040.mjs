// scripts/fix-sessoes-antonella-horario-1040.mjs
//
// Corrige Session.time de "10:00" (stale, pré-fix 2026-07-09) para "10:40"
// (horário correto, já refletido no Appointment) para as sessions futuras
// de Antonella Souza Eneas com Tatiana Celuta Peres (plano de convênio
// Psicopedagogia, guia #16241738).
//
// NÃO apaga nenhum documento. Só corrige o campo time.
// NÃO toca em sessions status=completed ou status=canceled.
//
// Uso:
//   node scripts/fix-sessoes-antonella-horario-1040.mjs --dry-run
//   node scripts/fix-sessoes-antonella-horario-1040.mjs

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const DRY_RUN = process.argv.includes('--dry-run');
const PATIENT_ID = '69e68467292f470dfe8ec285';
const DOCTOR_ID = '685c2affaec14c71635863b7';
const CORRECT_TIME = '10:40';
const STALE_TIME = '10:00';

const possibleEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'back', '.env'),
  path.resolve(process.cwd(), '..', 'back', '.env'),
];
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) { dotenv.config({ path: envPath }); break; }
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não encontrado.');
  process.exit(1);
}

async function main() {
  console.log(`🔌 Conectando ao MongoDB... ${DRY_RUN ? '[DRY-RUN]' : '[EXECUÇÃO REAL]'}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;
  console.log('✅ Conectado');

  const sessionsColl = db.collection('sessions');
  const appointmentsColl = db.collection('appointments');

  const patientObjectId = new mongoose.Types.ObjectId(PATIENT_ID);
  const doctorObjectId = new mongoose.Types.ObjectId(DOCTOR_ID);

  // Alvo: sessions da Antonella com Tatiana, time=10:00, status ativo (não completed/canceled)
  const targets = await sessionsColl.find({
    patient: patientObjectId,
    doctor: doctorObjectId,
    time: STALE_TIME,
    status: { $nin: ['completed', 'canceled'] },
  }).toArray();

  console.log(`\n🎯 Sessions candidatas (time=${STALE_TIME}, status ativo): ${targets.length}`);

  // Confirma que cada uma tem Appointment vinculado em 10:40 (a fonte de verdade)
  const validTargets = [];
  for (const s of targets) {
    if (!s.appointmentId) {
      console.log(`  ⚠️ ${s._id} sem appointmentId — pulando (não mexe)`);
      continue;
    }
    const appt = await appointmentsColl.findOne({ _id: s.appointmentId });
    if (!appt) {
      console.log(`  ⚠️ ${s._id} appointment ${s.appointmentId} não encontrado — pulando`);
      continue;
    }
    if (appt.time !== CORRECT_TIME) {
      console.log(`  ⚠️ ${s._id} appointment ${appt._id} está em time=${appt.time} (esperado ${CORRECT_TIME}) — pulando, não mexe`);
      continue;
    }
    validTargets.push({ session: s, appointment: appt });
  }

  console.log(`\n✅ Sessions validadas para correção: ${validTargets.length}`);
  validTargets.forEach(({ session: s }) => {
    console.log(`  - ${s._id} | date=${new Date(s.date).toISOString().split('T')[0]} | time=${s.time} → ${CORRECT_TIME} | status=${s.status}`);
  });

  if (validTargets.length === 0) {
    console.log('\nNada para corrigir. Encerrando.');
    await mongoose.disconnect();
    return;
  }

  // Backup antes de qualquer escrita
  const backupDir = path.resolve(process.cwd(), 'backups-mongo', `fix-antonella-horario-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(
    path.join(backupDir, 'sessions-before.json'),
    JSON.stringify(validTargets.map(v => v.session), null, 2)
  );
  console.log(`\n💾 Backup salvo em: ${backupDir}/sessions-before.json`);

  if (DRY_RUN) {
    console.log('\n🔒 DRY-RUN: nenhuma escrita realizada.');
    await mongoose.disconnect();
    return;
  }

  const bulkOps = validTargets.map(({ session: s }) => ({
    updateOne: {
      filter: { _id: s._id },
      update: { $set: { time: CORRECT_TIME, updatedAt: new Date() } }
    }
  }));

  const result = await sessionsColl.bulkWrite(bulkOps);
  console.log(`\n✅ Corrigido: ${result.modifiedCount} sessions atualizadas para time=${CORRECT_TIME}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
