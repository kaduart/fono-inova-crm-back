import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id').lean();
  const guide = await InsuranceGuide.findOne({ number: '15655250', patientId: patient._id }).lean();
  console.log('Guia 15655250:', guide);

  const sessions = await Session.find({ patient: patient._id, insuranceGuide: guide._id, status: 'completed' })
    .populate('appointmentId', 'time')
    .populate('doctor', 'fullName')
    .sort({ date: 1 })
    .lean();

  console.log(`\nSessoes da guia 15655250 (${sessions.length}):`);
  for (const s of sessions) {
    const sp = s.specialty || s.sessionType || '-';
    console.log(`  ${s.date.toISOString().slice(0,10)} ${s.appointmentId?.time || '-'} | ${sp.padEnd(20)} | ${s.doctor?.fullName?.padEnd(25)} | val:${s.sessionValue} | ${s._id}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
