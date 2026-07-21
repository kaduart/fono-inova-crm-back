// scripts/fix-sessoes-convenio-horario-divergente.mjs
//
// Corrige Session.time para bater com Appointment.time em TODOS os planos de
// convênio (InsurancePlan) com sessions futuras divergentes — mesmo bug da
// Antonella (edição de slot antes do fix de 2026-07-09 nunca propagou pra
// Session). Já corrigido: plano 6a3c0c31c3dd2574dca64fe3 (Antonella,
// Psicopedagogia). Este script cobre os demais planos.
//
// NÃO apaga nenhum documento. Só corrige o campo time.
// NÃO toca em sessions status=completed ou status=canceled.
// NÃO toca em appointments operationalStatus=canceled.
//
// Uso:
//   node scripts/fix-sessoes-convenio-horario-divergente.mjs --dry-run
//   node scripts/fix-sessoes-convenio-horario-divergente.mjs

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const DRY_RUN = process.argv.includes('--dry-run');

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

  const appointmentsColl = db.collection('appointments');
  const sessionsColl = db.collection('sessions');

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const futureAppts = await appointmentsColl.find({
    date: { $gte: startOfToday },
    insurancePlan: { $exists: true, $ne: null },
    operationalStatus: { $ne: 'canceled' },
  }).project({ _id: 1, time: 1, insurancePlan: 1, patient: 1, doctor: 1, date: 1 }).toArray();

  const apptIds = futureAppts.map(a => a._id);
  const apptById = new Map(futureAppts.map(a => [String(a._id), a]));

  const sessions = await sessionsColl.find({
    appointmentId: { $in: apptIds },
    status: { $nin: ['completed', 'canceled'] },
  }).toArray();

  const validTargets = [];
  for (const s of sessions) {
    const appt = apptById.get(String(s.appointmentId));
    if (!appt) continue;
    if (s.time !== appt.time) {
      validTargets.push({ session: s, appointment: appt });
    }
  }

  console.log(`\n✅ Sessions divergentes encontradas (exclui Antonella/Psicopedagogia já corrigida, completed e canceled): ${validTargets.length}`);

  const byPlan = new Map();
  validTargets.forEach(({ session: s, appointment: a }) => {
    const planId = String(a.insurancePlan);
    if (!byPlan.has(planId)) byPlan.set(planId, []);
    byPlan.get(planId).push({ s, a });
  });

  for (const [planId, items] of byPlan) {
    console.log(`\n📦 Plano ${planId} (${items.length} sessions):`);
    items.forEach(({ s, a }) => {
      console.log(`  - session=${s._id} | date=${new Date(s.date).toISOString().split('T')[0]} | time=${s.time} → ${a.time} | sessionStatus=${s.status}`);
    });
  }

  if (validTargets.length === 0) {
    console.log('\nNada para corrigir. Encerrando.');
    await mongoose.disconnect();
    return;
  }

  // Backup antes de qualquer escrita
  const backupDir = path.resolve(process.cwd(), 'backups-mongo', `fix-convenio-horario-divergente-${new Date().toISOString().replace(/[:.]/g, '-')}`);
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

  const bulkOps = validTargets.map(({ session: s, appointment: a }) => ({
    updateOne: {
      filter: { _id: s._id },
      update: { $set: { time: a.time, updatedAt: new Date() } }
    }
  }));

  const result = await sessionsColl.bulkWrite(bulkOps);
  console.log(`\n✅ Corrigido: ${result.modifiedCount} sessions atualizadas para bater com Appointment.time`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
