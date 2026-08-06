import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patients = await Patient.find({ fullName: /Lis.*Caldas|Caldas.*Lis/i }).select('fullName _id').lean();
  console.log('Pacientes "Lis*Caldas*":', patients.map(p => `${p.fullName} (${p._id})`).join(' | ') || 'nenhum encontrado');

  if (patients.length === 0) {
    const caldas = await Patient.find({ fullName: /Caldas/i }).select('fullName _id').lean();
    console.log('\nTodos os pacientes com "Caldas" no nome:', caldas.map(p => `${p.fullName} (${p._id})`).join(' | '));
  }

  const doctor = await Doctor.findOne({ fullName: /Tatiana Celuta Peres/i }).lean();

  for (const patient of patients) {
    console.log(`\n=== ${patient.fullName} (${patient._id}) ===`);
    const sess = await Session.find({
      patient: patient._id,
      date: { $gte: new Date('2026-07-01T00:00:00-03:00'), $lte: new Date('2026-07-31T23:59:59-03:00') }
    }).populate('doctor', 'fullName').sort({ date: 1 }).lean();
    console.log('Sessions em julho (qualquer doctor):');
    for (const s of sess) {
      console.log(`  [${s.status}] ${moment(s.date).tz('America/Sao_Paulo').format('DD/MM')} time=${s.time || '-'} doctor=${s.doctor?.fullName} id=${s._id} appt=${s.appointmentId || '-'}`);
    }

    for (const day of ['06', '20']) {
      const appts = await Appointment.find({
        patient: patient._id,
        date: { $gte: new Date(`2026-07-${day}T00:00:00-03:00`), $lte: new Date(`2026-07-${day}T23:59:59-03:00`) }
      }).populate('doctor', 'fullName').lean();
      console.log(`Appointments em ${day}/07 (qualquer doctor): ${appts.length}`);
      for (const a of appts) {
        console.log(`  ${moment(a.date).tz('America/Sao_Paulo').format('HH:mm')} doctor=${a.doctor?.fullName} status=${a.status} id=${a._id}`);
      }
    }
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
