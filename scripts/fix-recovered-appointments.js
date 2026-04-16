/**
 * 🔧 FIX: Corrige appointments recuperados que ficaram com patient/doctor null
 * e patientInfo.fullName = 'Recuperado'
 *
 * Causa: type mismatch — session.patient era string, patients._id é ObjectId
 *
 * DRY_RUN=true  → só lista (padrão)
 * DRY_RUN=false → corrige
 */

import mongoose from 'mongoose';
import { ObjectId } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';

function toObjectId(val) {
  if (!val) return null;
  if (val instanceof ObjectId) return val;
  try { return new ObjectId(val.toString()); } catch { return null; }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`\n🔍 Modo: ${DRY_RUN ? 'DRY RUN' : '⚠️  REAL'}\n`);

  // 1. Buscar appointments recuperados sem patient
  const broken = await db.collection('appointments').find({
    _recovered: true,
    $or: [
      { patient: null },
      { 'patientInfo.fullName': 'Recuperado' }
    ]
  }, { projection: { _id: 1, patient: 1, doctor: 1, patientInfo: 1 } }).toArray();

  console.log(`📊 Appointments a corrigir: ${broken.length}`);

  let fixed = 0;
  let notFound = 0;

  for (const appt of broken) {
    // Buscar a session vinculada
    const session = await db.collection('sessions').findOne(
      { appointmentId: appt._id },
      { projection: { patient: 1, doctor: 1 } }
    );

    if (!session) { notFound++; continue; }

    const patientOid = toObjectId(session.patient);
    const doctorOid  = toObjectId(session.doctor);

    if (!patientOid) { notFound++; continue; }

    // Buscar dados do paciente — cascata: patients → patients_view → outro appointment
    let patient =
      await db.collection('patients').findOne(
        { _id: patientOid },
        { projection: { fullName: 1, name: 1, phone: 1, dateOfBirth: 1, cpf: 1 } }
      ) ||
      await db.collection('patients_view').findOne(
        { _id: patientOid },
        { projection: { fullName: 1, name: 1, phone: 1, dateOfBirth: 1, cpf: 1 } }
      );

    // Último recurso: pegar patientInfo de outro appointment não-recuperado do mesmo paciente
    if (!patient) {
      const otherAppt = await db.collection('appointments').findOne(
        { patient: patientOid, _recovered: { $ne: true }, 'patientInfo.fullName': { $exists: true, $ne: null, $ne: 'Recuperado' } },
        { projection: { patientInfo: 1 } }
      );
      if (otherAppt?.patientInfo?.fullName) {
        patient = otherAppt.patientInfo;
        patient.fromAppt = true;
      }
    }

    if (!patient) { notFound++; continue; }

    const patientInfo = {
      fullName: patient.fullName || patient.name || 'Paciente',
      phone: patient.phone || '',
      dateOfBirth: patient.dateOfBirth || null,
      cpf: patient.cpf || ''
    };

    if (DRY_RUN && fixed < 5) {
      console.log(`  ✅ ${appt._id} → ${patientInfo.fullName}`);
    }

    if (!DRY_RUN) {
      await db.collection('appointments').updateOne(
        { _id: appt._id },
        { $set: {
          patient: patientOid,
          doctor: doctorOid,
          patientInfo
        }}
      );
    }

    fixed++;
  }

  console.log(`\n📊 Corrigíveis: ${fixed} | Sem dados: ${notFound}`);

  if (DRY_RUN) {
    console.log('\nℹ️  DRY RUN — nada alterado.');
    console.log('   Para executar: DRY_RUN=false node scripts/fix-recovered-appointments.js');
  } else {
    console.log(`✅ ${fixed} appointments corrigidos.`);
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
