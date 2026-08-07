import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  const cutoff = new Date('2026-03-01T00:00:00-03:00');

  const guides = await InsuranceGuide.find({ billingMode: 'per_guide' }).lean();
  console.log(`Total de guias per_guide: ${guides.length}`);

  let withSessionBeforeMarch = 0;
  const patientNames = new Map();

  for (const guide of guides) {
    const session = await Session.findOne({
      insuranceGuide: guide._id,
      status: 'completed',
      date: { $lt: cutoff }
    }).lean();

    if (session) {
      withSessionBeforeMarch++;
      const Patient = (await import('../models/Patient.js')).default;
      const patient = await Patient.findById(guide.patientId).select('fullName').lean();
      if (patient) {
        const key = patient.fullName;
        patientNames.set(key, (patientNames.get(key) || 0) + 1);
      }
    }
  }

  console.log(`\nGuias per_guide com sessão antes de março/2026: ${withSessionBeforeMarch}`);
  console.log('\nPacientes afetados:');
  for (const [name, count] of patientNames.entries()) {
    console.log(`  ${name}: ${count} guia(s)`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
