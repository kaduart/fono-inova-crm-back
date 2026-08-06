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
    date: { $gte: startDate, $lte: endDate }
  })
    .populate('patient', 'fullName')
    .sort({ date: 1, time: 1 })
    .lean();

  const lisSessions = sessions.filter(s => /lis/i.test(s.patient?.fullName || ''));
  console.log(`Sessões da Tatiana em julho com paciente contendo "lis": ${lisSessions.length}`);
  for (const s of lisSessions) {
    console.log(
      `[${s.status}] ${moment(s.date).tz('America/Sao_Paulo').format('DD/MM')} time=${s.time || '-'} ` +
      `paciente=${s.patient?.fullName} sessionValue=${s.sessionValue} paymentMethod=${s.paymentMethod} ` +
      `insuranceGuide=${s.insuranceGuide || '-'} package=${s.package || '-'} id=${s._id}`
    );
  }

  // Ver se há outras sessões no mesmo horário/dia com outros pacientes (indício de atendimento em grupo)
  for (const s of lisSessions) {
    const sameSlot = sessions.filter(x =>
      x._id.toString() !== s._id.toString() &&
      moment(x.date).format('YYYY-MM-DD') === moment(s.date).format('YYYY-MM-DD') &&
      x.time === s.time
    );
    if (sameSlot.length) {
      console.log(`\nMesmo dia/horário que ${s.patient?.fullName} (${moment(s.date).format('DD/MM')} ${s.time}):`);
      for (const x of sameSlot) {
        console.log(`  - ${x.patient?.fullName} status=${x.status} sessionValue=${x.sessionValue} id=${x._id}`);
      }
    }
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
