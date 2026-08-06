import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patients = await Patient.find({ fullName: /Enthony Kauan/i }).select('fullName _id').lean();
  console.log('Pacientes "Enthony Kauan*":', patients.map(p => `${p.fullName} (${p._id})`).join(' | '));

  for (const p of patients) {
    console.log(`\n=== Appointments do paciente ${p.fullName} entre 01/07 e 10/07 (qualquer doctor/status) ===`);
    const appts = await Appointment.find({
      patient: p._id,
      date: { $gte: new Date('2026-07-01T00:00:00-03:00'), $lte: new Date('2026-07-10T23:59:59-03:00') }
    }).populate('doctor', 'fullName specialty specialties').lean();
    for (const a of appts) {
      console.log(`  ${moment(a.date).tz('America/Sao_Paulo').format('ddd DD/MM HH:mm')} doctor=${a.doctor?.fullName || '???'} specialty=${a.specialty || '-'} status=${a.status} id=${a._id}`);
    }

    console.log(`\n=== Sessions do paciente ${p.fullName} entre 01/07 e 10/07 (qualquer doctor/status) ===`);
    const sess = await Session.find({
      patient: p._id,
      date: { $gte: new Date('2026-07-01T00:00:00-03:00'), $lte: new Date('2026-07-10T23:59:59-03:00') }
    }).populate('doctor', 'fullName specialty specialties').lean();
    for (const s of sess) {
      console.log(`  ${moment(s.date).tz('America/Sao_Paulo').format('ddd DD/MM')} time=${s.time || '-'} doctor=${s.doctor?.fullName || '???'} sessionType=${s.sessionType} status=${s.status} id=${s._id} appt=${s.appointmentId || '-'}`);
    }
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
