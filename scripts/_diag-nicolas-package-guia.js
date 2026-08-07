import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Package = (await import('../models/Package.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Session = (await import('../models/Session.js')).default;

  const guide = await InsuranceGuide.findOne({ number: '15650231' }).lean();
  console.log('Guia:', JSON.stringify(guide, null, 2));

  if (guide.packageId) {
    const pkg = await Package.findById(guide.packageId).lean();
    console.log('\nPackage:', JSON.stringify(pkg, null, 2));
  }

  const sessions = await Session.find({ insuranceGuide: guide._id })
    .populate('appointmentId', 'specialty time')
    .select('date specialty sessionType appointmentId')
    .sort({ date: 1 })
    .lean();

  console.log('\nSessões:');
  for (const s of sessions) {
    console.log(`${s.date.toISOString()} | session:${s.specialty || s.sessionType} | appointment:${s.appointmentId?.specialty}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
