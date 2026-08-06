import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Doctor from '../models/Doctor.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const doctor = await Doctor.findOne({ fullName: /Tatiana Celuta Peres/i }).lean();

  const target = moment.tz({ year: 2026, month: 6 }, 'America/Sao_Paulo');
  const startDate = target.clone().startOf('month').toDate();
  const endDate = target.clone().endOf('month').toDate();

  const sessions = await Session.find({
    doctor: doctor._id,
    date: { $gte: startDate, $lte: endDate },
    status: 'completed'
  })
    .populate('patient', 'fullName')
    .lean();

  const byPatient = new Map();
  for (const s of sessions) {
    const name = s.patient?.fullName || '???';
    byPatient.set(name, (byPatient.get(name) || 0) + 1);
  }

  console.log(`Pacientes distintos (completed) em julho: ${byPatient.size}\n`);
  for (const [name, count] of [...byPatient.entries()].sort()) {
    console.log(`  ${count}x  ${name}`);
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
