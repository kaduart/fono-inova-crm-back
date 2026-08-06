import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const doctor = await Doctor.findOne({ fullName: /Tatiana Celuta Peres/i }).lean();
  console.log('Doctor:', doctor?._id, doctor?.fullName, '| active:', doctor?.active, '| specialty:', doctor?.specialty);

  const target = moment.tz({ year: 2026, month: 6 }, 'America/Sao_Paulo'); // julho
  const startDate = target.clone().startOf('month').toDate();
  const endDate = target.clone().endOf('month').toDate();

  const sessions = await Session.find({
    doctor: doctor._id,
    date: { $gte: startDate, $lte: endDate }
  })
    .populate('patient', 'fullName')
    .sort({ date: 1, time: 1 })
    .lean();

  const byStatus = {};
  for (const s of sessions) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  console.log(`\nTotal Sessions no mês: ${sessions.length} | por status:`, byStatus);

  // 1) Duplicatas: mesmo paciente + mesma data, completed
  const seen = new Map();
  for (const s of sessions.filter(s => s.status === 'completed')) {
    const key = `${s.patient?._id}_${moment(s.date).format('YYYY-MM-DD')}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push({ id: s._id.toString(), time: s.time, patient: s.patient?.fullName });
  }
  const dups = [...seen.entries()].filter(([, arr]) => arr.length > 1);
  console.log(`\n⚠️  Mesmo paciente + mesma data (completed), ${dups.length} grupo(s):`);
  for (const [key, arr] of dups) {
    console.log(`  ${key}:`, arr.map(a => `${a.time} (${a.id})`).join(', '));
  }

  // 2) Appointment.doctor != Session.doctor (mesmo bug do Enthony/Ana Paula)
  const apptIds = sessions.map(s => s.appointmentId).filter(Boolean);
  const appts = await Appointment.find({ _id: { $in: apptIds } }).select('doctor patient date').lean();
  const apptById = new Map(appts.map(a => [a._id.toString(), a]));
  console.log(`\n⚠️  Appointment.doctor ≠ Session.doctor:`);
  let mismatchCount = 0;
  for (const s of sessions) {
    if (!s.appointmentId) continue;
    const appt = apptById.get(s.appointmentId.toString());
    if (!appt) continue;
    if (appt.doctor?.toString() !== s.doctor?.toString()) {
      mismatchCount++;
      console.log(`  session=${s._id} appt=${s.appointmentId} paciente=${s.patient?.fullName} apptDoctor=${appt.doctor} sessionDoctor=${s.doctor} status=${s.status}`);
    }
  }
  if (mismatchCount === 0) console.log('  nenhum encontrado');

  // 3) scheduled/pending com data já passada (hoje = 06/08/2026)
  const today = moment.tz('2026-08-06', 'America/Sao_Paulo').endOf('day');
  const stale = sessions.filter(s => ['scheduled', 'pending', 'confirmed'].includes(s.status) && moment(s.date).isBefore(today));
  console.log(`\n⚠️  Presas em scheduled/pending/confirmed com data já passada: ${stale.length}`);
  for (const s of stale) {
    console.log(`  ${moment(s.date).tz('America/Sao_Paulo').format('DD/MM')} ${s.time || '-'} paciente=${s.patient?.fullName} status=${s.status} id=${s._id}`);
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
