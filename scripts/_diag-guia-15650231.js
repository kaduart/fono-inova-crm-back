import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const guide = await InsuranceGuide.findOne({ number: '15650231' }).lean();
  console.log('Guia 15650231:', JSON.stringify(guide, null, 2));

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id').lean();
  const sessions = await Session.find({ patient: patient._id, insuranceGuide: guide._id })
    .select('date specialty sessionType sessionValue billingBatchId')
    .sort({ date: 1 })
    .lean();

  console.log('\nSessões na guia 15650231:');
  for (const s of sessions) {
    console.log(`${s.date.toISOString()} | ${s.specialty || s.sessionType} | sessionValue:${s.sessionValue} | batch:${s.billingBatchId}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
