#!/usr/bin/env node
/**
 * 🔧 Corrige sessões cujo session.patient aponta para paciente inexistente,
 * mas cujo appointment.patient é válido.
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function run() {
  await mongoose.connect(MONGO_URI);

  const Session = (await import('../models/Session.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const sessions = await Session.find({
    patient: { $exists: true, $ne: null }
  }).select('patient appointmentId').lean();

  const patientIds = [...new Set(sessions.map(s => s.patient?.toString()).filter(Boolean))];
  const existingPatients = await Patient.find({ _id: { $in: patientIds } }).select('_id').lean();
  const existingPatientIds = new Set(existingPatients.map(p => p._id.toString()));

  const orphanSessions = sessions.filter(s => !existingPatientIds.has(s.patient.toString()));
  console.log(`Sessões com patient inexistente encontradas: ${orphanSessions.length}`);

  let fixed = 0;
  for (const s of orphanSessions) {
    if (!s.appointmentId) {
      console.log(`  ${s._id}: sem appointmentId — pulando`);
      continue;
    }
    const appt = await Appointment.findById(s.appointmentId).select('patient').lean();
    if (!appt?.patient) {
      console.log(`  ${s._id}: appointment sem patient — pulando`);
      continue;
    }

    const correctPatientId = appt.patient.toString();
    const patientExists = existingPatientIds.has(correctPatientId);
    if (!patientExists) {
      console.log(`  ${s._id}: appointment.patient ${correctPatientId} também inexistente — pulando`);
      continue;
    }

    await Session.updateOne(
      { _id: s._id },
      { $set: { patient: appt.patient } }
    );

    console.log(`  ✅ ${s._id}: patient corrigido de ${s.patient} para ${correctPatientId}`);
    fixed += 1;
  }

  console.log(`\nTotal corrigido: ${fixed}/${orphanSessions.length}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
