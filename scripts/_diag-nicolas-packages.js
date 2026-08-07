import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const Package = (await import('../models/Package.js')).default;

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id').lean();
  const packages = await Package.find({ patient: patient._id, type: 'convenio' }).lean();

  console.log('Packages do Nicolas:', packages.length);
  for (const pkg of packages) {
    console.log('\nPackage', pkg._id.toString());
    console.log('  specialty:', pkg.specialty);
    console.log('  insuranceProvider:', pkg.insuranceProvider);
    console.log('  status:', pkg.status);
    console.log('  appointments:', pkg.appointments?.length || 0);

    const sessions = await Session.find({ patient: patient._id, package: pkg._id }).select('date specialty sessionType insuranceGuide').lean();
    console.log('  sessoes vinculadas:', sessions.length);
    for (const s of sessions) {
      console.log(`    ${s.date.toISOString().slice(0,10)} | ${s.specialty || s.sessionType} | guia:${s.insuranceGuide || 'null'} | ${s._id}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
