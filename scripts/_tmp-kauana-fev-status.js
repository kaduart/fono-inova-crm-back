import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id').lean();
  const startFeb = new Date('2026-02-01T00:00:00-03:00');
  const endFeb = new Date('2026-02-29T23:59:59-03:00');
  const sessions = await Session.find({ patient: patient._id, date: { $gte: startFeb, $lte: endFeb } }).sort({ date: 1 }).lean();
  console.log('Todas as sessoes de Kauana em fev/2026 (qualquer status):', sessions.length);
  for (const s of sessions) {
    console.log(s.date.toISOString().slice(0,10), s.status, (s.specialty || s.sessionType || '-').padEnd(20), s.sessionValue, s._id.toString());
  }
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
