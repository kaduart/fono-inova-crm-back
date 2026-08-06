import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patientId = '6a27277e857a29ad236d32d2'; // Liz Caldas Rabellatto

  const pkgs = await Package.find({ patient: patientId }).sort({ createdAt: -1 }).lean();
  console.log(`Packages da Liz: ${pkgs.length}`);
  for (const p of pkgs) {
    console.log(`  id=${p._id} totalSessions=${p.totalSessions} sessionsDone=${p.sessionsDone} date=${p.date} status=${p.status} createdAt=${moment(p.createdAt).tz('America/Sao_Paulo').format('DD/MM HH:mm')}`);
  }

  const appts = await Appointment.find({ patient: patientId }).populate('doctor', 'fullName').sort({ date: 1 }).lean();
  console.log(`\nAppointments da Liz (todos): ${appts.length}`);
  for (const a of appts) {
    console.log(`  ${moment(a.date).tz('America/Sao_Paulo').format('DD/MM/YYYY')} ${a.time} doctor=${a.doctor?.fullName} status=${a.operationalStatus} package=${a.package || '-'} id=${a._id} createdAt=${moment(a.createdAt).tz('America/Sao_Paulo').format('DD/MM HH:mm')}`);
  }

  const sess = await Session.find({ patient: patientId }).populate('doctor', 'fullName').sort({ date: 1 }).lean();
  console.log(`\nSessions da Liz (todas): ${sess.length}`);
  for (const s of sess) {
    console.log(`  ${moment(s.date).tz('America/Sao_Paulo').format('DD/MM/YYYY')} ${s.time} doctor=${s.doctor?.fullName} status=${s.status} package=${s.package || '-'} id=${s._id}`);
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
