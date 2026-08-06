import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const target = moment.tz({ year: 2026, month: 6 }, 'America/Sao_Paulo'); // julho
  const startDate = target.clone().startOf('month').toDate();
  const endDate = target.clone().endOf('month').toDate();

  const doctorId = '6a0cd1d0f5d1991be385b58b'; // Ana Paula

  const sessions = await Session.find({
    doctor: new mongoose.Types.ObjectId(doctorId),
    date: { $gte: startDate, $lte: endDate }
  })
    .populate('patient', 'fullName')
    .sort({ date: 1, time: 1 })
    .lean();

  console.log(`Total de Sessions no mês (qualquer status): ${sessions.length}`);
  const completed = sessions.filter(s => s.status === 'completed');
  console.log(`status='completed': ${completed.length}`);

  for (const s of sessions) {
    console.log(
      `[${s.status.padEnd(9)}] ${moment(s.date).tz('America/Sao_Paulo').format('ddd DD/MM')} time=${s.time || '-'} ` +
      `paciente=${s.patient?.fullName || '???'} canceledAt=${s.canceledAt ? moment(s.canceledAt).format('DD/MM HH:mm') : '-'} ` +
      `id=${s._id} appt=${s.appointmentId || '-'}`
    );
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
