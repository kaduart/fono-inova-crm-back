import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const target = moment.tz({ year: 2026, month: 6 }, 'America/Sao_Paulo'); // month index 6 = julho
  const startDate = target.clone().startOf('month').toDate();
  const endDate = target.clone().endOf('month').toDate();

  console.log('Range usado pela geração de comissão (commissionService.js):');
  console.log('  start:', startDate.toISOString(), '| end:', endDate.toISOString());

  const doctors = [
    { name: 'Debora Kauane Menezes Barreira', id: '6a51414e8fabfdae6a78415b' },
    { name: 'Gabrielle Campos Ferreira', id: '6a54ff9816c9749cae105c0f' }
  ];

  for (const doc of doctors) {
    console.log(`\n================ ${doc.name} (${doc.id}) ================`);

    const allStatusSessions = await Session.find({
      doctor: new mongoose.Types.ObjectId(doc.id),
      date: { $gte: startDate, $lte: endDate }
    })
      .populate('patient', 'fullName')
      .sort({ date: 1, time: 1 })
      .lean();

    console.log(`Total de Sessions no mês (qualquer status): ${allStatusSessions.length}`);

    const completed = allStatusSessions.filter(s => s.status === 'completed');
    const completedNotCanceled = completed.filter(s => !s.canceledAt);

    console.log(`status='completed': ${completed.length}`);
    console.log(`status='completed' && !canceledAt (usado no cálculo real): ${completedNotCanceled.length}`);

    for (const s of allStatusSessions) {
      console.log(
        `  [${s.status.padEnd(9)}] ${moment(s.date).tz('America/Sao_Paulo').format('DD/MM HH:mm')} (time=${s.time || '-'}) ` +
        `paciente=${s.patient?.fullName || '???'} ` +
        `canceledAt=${s.canceledAt ? moment(s.canceledAt).format('DD/MM HH:mm') : '-'} ` +
        `sessionId=${s._id} appointmentId=${s.appointmentId || '-'}`
      );
    }

    // checar duplicatas: mesmo paciente + mesma data + completed
    const seen = new Map();
    for (const s of completedNotCanceled) {
      const key = `${s.patient?._id}_${moment(s.date).format('YYYY-MM-DD')}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(s._id.toString());
    }
    const dups = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    if (dups.length) {
      console.log('⚠️  Possíveis duplicatas (mesmo paciente + mesma data, completed):');
      for (const [key, ids] of dups) console.log(`    ${key} -> ${ids.join(', ')}`);
    }
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
