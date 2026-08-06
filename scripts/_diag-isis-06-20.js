import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patientId = '685b0cfaaec14c7163585b5b'; // Isis Caldas Rebelatto

  const sess = await Session.find({
    patient: patientId,
    date: { $gte: new Date('2026-07-01T00:00:00-03:00'), $lte: new Date('2026-07-31T23:59:59-03:00') }
  }).populate('doctor', 'fullName').sort({ date: 1 }).lean();

  console.log(`Sessions da Isis Caldas Rebelatto em julho: ${sess.length}`);
  for (const s of sess) {
    console.log(`  [${s.status}] ${moment(s.date).tz('America/Sao_Paulo').format('DD/MM')} time=${s.time || '-'} doctor=${s.doctor?.fullName || '???'} sessionValue=${s.sessionValue} id=${s._id}`);
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
