import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // 1) Existe mais de um paciente com esse nome? (duplicata de cadastro)
  const patients = await Patient.find({ fullName: /Lucas Gabriel/i }).select('fullName _id createdAt').lean();
  console.log('Pacientes "Lucas Gabriel*":', patients.map(p => `${p.fullName} (${p._id})`).join(' | '));

  const gabrielle = await Doctor.findOne({ fullName: /Gabrielle Campos Ferreira/i }).select('_id fullName').lean();
  console.log('Doctor Gabrielle:', gabrielle?._id);

  // 2) TODOS os appointments da Gabrielle em torno de 10/07 (qualquer paciente) — pra ver se teve algo esse dia
  const apptsGabrielleDay = await Appointment.find({
    doctor: gabrielle._id,
    date: { $gte: new Date('2026-07-09T00:00:00-03:00'), $lte: new Date('2026-07-11T23:59:59-03:00') }
  }).populate('patient', 'fullName').lean();
  console.log(`\nAppointments da Gabrielle entre 09/07 e 11/07 (qualquer paciente): ${apptsGabrielleDay.length}`);
  for (const a of apptsGabrielleDay) {
    console.log(`  ${moment(a.date).tz('America/Sao_Paulo').format('DD/MM HH:mm')} paciente=${a.patient?.fullName || '???'} status=${a.status} id=${a._id}`);
  }

  // 3) Todos os appointments do Lucas (qualquer doctor) em torno de 10/07
  for (const p of patients) {
    const apptsPatientDay = await Appointment.find({
      patient: p._id,
      date: { $gte: new Date('2026-07-09T00:00:00-03:00'), $lte: new Date('2026-07-11T23:59:59-03:00') }
    }).populate('doctor', 'fullName').lean();
    console.log(`\nAppointments do paciente ${p.fullName} (${p._id}) entre 09/07 e 11/07: ${apptsPatientDay.length}`);
    for (const a of apptsPatientDay) {
      console.log(`  ${moment(a.date).tz('America/Sao_Paulo').format('DD/MM HH:mm')} doctor=${a.doctor?.fullName || '???'} status=${a.status} id=${a._id}`);
    }
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
