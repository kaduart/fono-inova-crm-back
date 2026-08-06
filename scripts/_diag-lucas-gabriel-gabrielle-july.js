import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Patient from '../models/Patient.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patient = await Patient.findOne({ fullName: /Lucas Gabriel de Ara.jo Costa/i }).lean();
  console.log('Patient:', patient?._id, patient?.fullName);

  const sessions = await Session.find({
    patient: patient._id,
    date: { $gte: new Date('2026-06-15T00:00:00-03:00'), $lte: new Date('2026-08-05T23:59:59-03:00') }
  }).populate('doctor', 'fullName').sort({ date: 1 }).lean();

  for (const s of sessions) {
    console.log(
      `[${s.status.padEnd(9)}] ${moment(s.date).tz('America/Sao_Paulo').format('ddd DD/MM')} time=${s.time || '-'} ` +
      `doctor=${s.doctor?.fullName || '???'} canceledAt=${s.canceledAt ? moment(s.canceledAt).format('DD/MM HH:mm') : '-'} ` +
      `id=${s._id} appt=${s.appointmentId || '-'} createdAt=${moment(s.createdAt).format('DD/MM HH:mm')}`
    );
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
