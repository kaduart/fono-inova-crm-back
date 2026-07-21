// scripts/auditar-conflito-antonella.mjs
//
// Investiga conflito de agenda para Antonella Souza Eneas
// e lista slots ocupados pela paciente com a Dra. Tatiana.
//
// Uso:
//   node scripts/auditar-conflito-antonella.mjs --dry-run
//   node scripts/auditar-conflito-antonella.mjs

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_CONFLICT_ID = '6a3c0c33c3dd2574dca65011';
const PATIENT_ID = '69e68467292f470dfe8ec285';
const DOCTOR_ID = '685c2affaec14c71635863b7';
const TARGET_DATE = '2026-07-23';
const TARGET_TIME = '10:00';

const possibleEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'back', '.env'),
  path.resolve(process.cwd(), '..', 'back', '.env'),
];

let loadedEnv = false;
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    loadedEnv = true;
    break;
  }
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não encontrado. Execute a partir de /back ou da raiz do projeto.');
  process.exit(1);
}

async function main() {
  console.log(`🔌 Conectando ao MongoDB... ${DRY_RUN ? '[DRY-RUN]' : ''}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;
  console.log('✅ Conectado');

  const appointmentsColl = db.collection('appointments');
  const sessionsColl = db.collection('sessions');

  // 1. Conflito específico em appointments
  const conflict = await appointmentsColl.findOne({ _id: new mongoose.Types.ObjectId(TARGET_CONFLICT_ID) });
  console.log('\n📋 Agendamento conflitante (appointments):');
  if (conflict) {
    console.log(JSON.stringify({
      _id: conflict._id,
      patient: conflict.patient,
      patientName: conflict.patientName,
      doctor: conflict.doctor,
      date: conflict.date,
      time: conflict.time,
      duration: conflict.duration,
      operationalStatus: conflict.operationalStatus,
      paymentStatus: conflict.paymentStatus,
      status: conflict.status,
      createdAt: conflict.createdAt,
      updatedAt: conflict.updatedAt,
    }, null, 2));
  } else {
    console.log('  ❌ Não encontrado em appointments');
  }

  // 1b. Conflito específico em sessions
  const conflictSession = await sessionsColl.findOne({ _id: new mongoose.Types.ObjectId(TARGET_CONFLICT_ID) });
  console.log('\n📋 Sessão conflitante (sessions):');
  if (conflictSession) {
    console.log(JSON.stringify({
      _id: conflictSession._id,
      patient: conflictSession.patient,
      appointment: conflictSession.appointment,
      doctor: conflictSession.doctor,
      date: conflictSession.date,
      time: conflictSession.time,
      duration: conflictSession.duration,
      status: conflictSession.status,
      paymentStatus: conflictSession.paymentStatus,
      createdAt: conflictSession.createdAt,
      updatedAt: conflictSession.updatedAt,
    }, null, 2));
  } else {
    console.log('  ❌ Não encontrado em sessions');
  }

  // 2. Todos os agendamentos futuros da paciente com a mesma doutora
  const patientObjectId = new mongoose.Types.ObjectId(PATIENT_ID);
  const doctorObjectId = new mongoose.Types.ObjectId(DOCTOR_ID);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const query = {
    patient: patientObjectId,
    doctor: doctorObjectId,
    date: { $gte: startOfToday },
  };

  const patientSlots = await appointmentsColl
    .find(query)
    .sort({ date: 1, time: 1 })
    .toArray();

  console.log(`\n📅 Agendamentos futuros de Antonella com Tatiana (${patientSlots.length} encontrados):`);
  patientSlots.forEach((a) => {
    console.log(`  - ${a._id} | ${a.date ? new Date(a.date).toISOString().split('T')[0] : 'sem data'} ${a.time || ''} | status=${a.operationalStatus || a.status} | ${a.patientName || ''}`);
  });

  // 3. Slot específico 23/07 10:00
  const targetDateMidnight = new Date(`${TARGET_DATE}T00:00:00.000Z`);
  const slotQuery = {
    doctor: doctorObjectId,
    date: targetDateMidnight,
    time: TARGET_TIME,
  };
  const slotOccupants = await appointmentsColl.find(slotQuery).toArray();
  const sessionSlotOccupants = await sessionsColl.find(slotQuery).toArray();
  console.log(`\n🎯 Slot ${TARGET_DATE} ${TARGET_TIME} com Tatiana:`);
  console.log(`  Appointments (${slotOccupants.length}):`);
  slotOccupants.forEach((a) => {
    console.log(`    - ${a._id} | patient=${a.patientName || a.patient} | status=${a.operationalStatus || a.status}`);
  });
  console.log(`  Sessions (${sessionSlotOccupants.length}):`);
  sessionSlotOccupants.forEach((a) => {
    console.log(`    - ${a._id} | appointment=${a.appointment?.toString?.()} | patient=${a.patient?.toString?.()} | status=${a.status}`);
  });

  // 4. Verifica vínculo da sessão conflitante com appointment
  if (conflictSession?.appointment) {
    const parentAppt = await appointmentsColl.findOne({ _id: new mongoose.Types.ObjectId(conflictSession.appointment.toString()) });
    console.log('\n🔗 Appointment pai da sessão conflitante:');
    if (parentAppt) {
      console.log(JSON.stringify({
        _id: parentAppt._id,
        patientName: parentAppt.patientName,
        date: parentAppt.date,
        time: parentAppt.time,
        session: parentAppt.session,
        sessions: parentAppt.sessions,
        operationalStatus: parentAppt.operationalStatus,
        status: parentAppt.status,
      }, null, 2));
    } else {
      console.log('  ❌ Appointment pai não encontrado');
    }
  }

  // 5. Sessões da paciente futuras com a doutora
  const sessionQuery = {
    patient: patientObjectId,
    doctor: doctorObjectId,
    date: { $gte: startOfToday },
  };
  const patientSessions = await sessionsColl.find(sessionQuery).sort({ date: 1, time: 1 }).toArray();
  console.log(`\n📅 Sessões futuras de Antonella com Tatiana (${patientSessions.length} encontradas):`);
  patientSessions.forEach((s) => {
    console.log(`  - ${s._id} | ${s.date ? new Date(s.date).toISOString().split('T')[0] : 'sem data'} ${s.time || ''} | especialidade=${s.sessionType || ''} | status=${s.status} | paymentStatus=${s.paymentStatus} | appointmentId=${s.appointmentId?.toString?.() || ''} | package=${s.package?.toString?.() || '(nenhum)'}`);
  });

  // 6. Resumo de pacotes, doutores e especialidades das sessões futuras
  const doctorsColl = db.collection('doctors');
  const uniqueDoctorIds = [...new Set(patientSessions.map((s) => s.doctor?.toString?.()).filter(Boolean))];
  const doctorsMap = new Map();
  for (const docId of uniqueDoctorIds) {
    const doctor = await doctorsColl.findOne({ _id: new mongoose.Types.ObjectId(docId) });
    doctorsMap.set(docId, doctor || null);
  }

  const uniquePackages = [...new Set(patientSessions.map((s) => s.package?.toString?.()).filter(Boolean))];
  const uniqueTimes = [...new Set(patientSessions.map((s) => s.time).filter(Boolean))];
  const uniqueSpecialties = [...new Set(patientSessions.map((s) => s.sessionType).filter(Boolean))];

  console.log(`\n📊 Resumo das ${patientSessions.length} sessões futuras:`);
  console.log(`  Horários distintos: ${uniqueTimes.join(', ') || 'nenhum'}`);
  console.log(`  Especialidades distintas: ${uniqueSpecialties.join(', ') || 'nenhum'}`);
  console.log(`  Doutores distintos (${uniqueDoctorIds.length}):`);
  uniqueDoctorIds.forEach((id) => {
    const d = doctorsMap.get(id);
    console.log(`    - ${id} | ${d?.fullName || d?.name || 'nome não encontrado'} | especialidade=${d?.specialty || d?.specialties?.join(', ') || 'não informada'}`);
  });
  console.log(`  Pacotes distintos (${uniquePackages.length}): ${uniquePackages.join(', ') || 'nenhum'}`);

  if (uniquePackages.length === 1) {
    console.log('  ✅ Todas as sessões pertencem ao MESMO pacote.');
  } else if (uniquePackages.length > 1) {
    console.log('  ⚠️ Sessões pertencem a pacotes DIFERENTES.');
  } else {
    console.log('  ℹ️ Nenhuma sessão vinculada a pacote.');
  }

  // 7. Detalhes do pacote (se houver)
  if (uniquePackages.length > 0) {
    const packagesColl = db.collection('packages');
    const packages = await packagesColl.find({ _id: { $in: uniquePackages.map((id) => new mongoose.Types.ObjectId(id)) } }).toArray();
    console.log(`\n📦 Detalhes dos pacotes:`);
    packages.forEach((p) => {
      console.log(`  - ${p._id} | patient=${p.patient?.toString?.()} | totalSessions=${p.totalSessions} | usedSessions=${p.usedSessions} | status=${p.status}`);
    });
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
