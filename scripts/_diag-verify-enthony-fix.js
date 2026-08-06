import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const s = await Session.findById('69c1456fc19d35b8454a2894')
    .populate('doctor', 'fullName')
    .populate('patient', 'fullName')
    .lean();

  console.log('Session 69c1456fc19d35b8454a2894 após o fix:');
  console.log(`  doctor: ${s.doctor?.fullName} (${s.doctor?._id})`);
  console.log(`  patient: ${s.patient?.fullName}`);
  console.log(`  status: ${s.status}`);
  console.log(`  date: ${moment(s.date).tz('America/Sao_Paulo').format('DD/MM/YYYY')} time=${s.time}`);
  console.log(`  paymentMethod: ${s.paymentMethod}`);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
