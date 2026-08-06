import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Package from '../models/Package.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const pkg = await Package.findById('6a74c2a23924c1989a331df9').lean();
  console.log('Package:', JSON.stringify({
    _id: pkg._id,
    totalSessions: pkg.totalSessions,
    sessionsPerWeek: pkg.sessionsPerWeek,
    frequencyInterval: pkg.frequencyInterval,
    durationMonths: pkg.durationMonths,
    date: pkg.date,
    appointments: pkg.appointments,
    sessions: pkg.sessions
  }, null, 2));

  const appts = await Appointment.find({ package: pkg._id }).select('date time status operationalStatus').lean();
  console.log('\nAppointments:');
  for (const a of appts) {
    console.log(`  ${moment(a.date).tz('America/Sao_Paulo').format('DD/MM/YYYY')} ${a.time} status=${a.status || a.operationalStatus}`);
  }

  const sessions = await Session.find({ package: pkg._id }).select('date time status').lean();
  console.log('\nSessions:');
  for (const s of sessions) {
    console.log(`  ${moment(s.date).tz('America/Sao_Paulo').format('DD/MM/YYYY')} ${s.time} status=${s.status}`);
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
