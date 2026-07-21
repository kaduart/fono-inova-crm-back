// scripts/audit-appointment-session-consistency.mjs
//
// Auditoria read-only: Appointment vs Session vinculada (mesmo appointmentId).
// Verifica doctor, time, date divergentes + órfãos. Não altera nada.
//
// Uso: node scripts/audit-appointment-session-consistency.mjs

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGO_URI não encontrado.'); process.exit(1); }

async function main() {
  console.log('🔌 Conectando ao MongoDB... [READ-ONLY]');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;
  console.log('✅ Conectado');

  const appointmentsColl = db.collection('appointments');
  const sessionsColl = db.collection('sessions');

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // Só appointments futuros e ativos (fonte de verdade)
  const appts = await appointmentsColl.find({
    date: { $gte: startOfToday },
    operationalStatus: { $in: ['pre_agendado', 'scheduled', 'confirmed'] },
  }).project({ _id: 1, time: 1, date: 1, doctor: 1, patient: 1, patientName: 1, insuranceGuide: 1 }).toArray();

  const apptById = new Map(appts.map(a => [String(a._id), a]));
  const apptIds = appts.map(a => a._id);

  const sessions = await sessionsColl.find({
    appointmentId: { $in: apptIds },
  }).project({ _id: 1, appointmentId: 1, time: 1, date: 1, doctor: 1, status: 1 }).toArray();

  const sessionByAppt = new Map(sessions.map(s => [String(s.appointmentId), s]));

  let doctorMismatch = 0;
  let timeMismatch = 0;
  let dateMismatch = 0;
  let sessionMissing = 0;
  const doctorMismatchDetails = [];
  const timeMismatchDetails = [];
  const dateMismatchDetails = [];

  for (const a of appts) {
    const s = sessionByAppt.get(String(a._id));
    if (!s) { sessionMissing++; continue; }
    if (s.status === 'completed' || s.status === 'canceled') continue; // não mexe/concluído

    if (String(s.doctor) !== String(a.doctor)) {
      doctorMismatch++;
      doctorMismatchDetails.push({ appointmentId: a._id, patient: a.patientName, apptDoctor: a.doctor, sessionDoctor: s.doctor, date: a.date });
    }
    if (s.time !== a.time) {
      timeMismatch++;
      timeMismatchDetails.push({ appointmentId: a._id, patient: a.patientName, apptTime: a.time, sessionTime: s.time, date: a.date });
    }
    const aDate = new Date(a.date).toISOString().split('T')[0];
    const sDate = new Date(s.date).toISOString().split('T')[0];
    if (aDate !== sDate) {
      dateMismatch++;
      dateMismatchDetails.push({ appointmentId: a._id, patient: a.patientName, apptDate: aDate, sessionDate: sDate });
    }
  }

  // Órfãos: Session ativa sem Appointment correspondente ativo
  const orphanSessions = await sessionsColl.find({
    status: { $nin: ['completed', 'canceled'] },
    date: { $gte: startOfToday },
    appointmentId: { $exists: true, $ne: null },
  }).project({ _id: 1, appointmentId: 1, patient: 1, date: 1 }).toArray();

  let orphanCount = 0;
  for (const s of orphanSessions) {
    if (!apptById.has(String(s.appointmentId))) {
      // pode ser appointment cancelado/completo (fora do filtro ativo) — checa direto
      const appt = await appointmentsColl.findOne({ _id: s.appointmentId });
      if (!appt || ['canceled', 'force_cancelled'].includes(appt.operationalStatus)) {
        orphanCount++;
      }
    }
  }

  console.log('\n════════ RESULTADO DA AUDITORIA ════════');
  console.log(`Appointments futuros ativos analisados: ${appts.length}`);
  console.log(`Sessions sem vínculo (appointment sem Session criada): ${sessionMissing}`);
  console.log(`Doctor divergente (Appointment.doctor != Session.doctor): ${doctorMismatch}`);
  console.log(`Time divergente (Appointment.time != Session.time): ${timeMismatch}`);
  console.log(`Date divergente (Appointment.date != Session.date): ${dateMismatch}`);
  console.log(`Sessions órfãs (appointment cancelado/inexistente, session ainda ativa): ${orphanCount}`);

  if (doctorMismatchDetails.length > 0) {
    console.log('\n--- Doctor divergente (detalhe) ---');
    doctorMismatchDetails.forEach(d => console.log(`  ${d.appointmentId} | ${d.patient} | ${new Date(d.date).toISOString().split('T')[0]} | appt.doctor=${d.apptDoctor} session.doctor=${d.sessionDoctor}`));
  }
  if (timeMismatchDetails.length > 0) {
    console.log('\n--- Time divergente (detalhe) ---');
    timeMismatchDetails.forEach(d => console.log(`  ${d.appointmentId} | ${d.patient} | ${new Date(d.date).toISOString().split('T')[0]} | appt.time=${d.apptTime} session.time=${d.sessionTime}`));
  }
  if (dateMismatchDetails.length > 0) {
    console.log('\n--- Date divergente (detalhe) ---');
    dateMismatchDetails.forEach(d => console.log(`  ${d.appointmentId} | ${d.patient} | appt.date=${d.apptDate} session.date=${d.sessionDate}`));
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('❌ Erro:', err); process.exit(1); });
