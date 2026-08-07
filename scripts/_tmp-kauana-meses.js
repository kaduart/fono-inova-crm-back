import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id').lean();
  const guides = await InsuranceGuide.find({ patientId: patient._id, number: { $in: ['2027', '2028', '2029'] } }).select('_id number specialty').lean();
  const guideMap = {};
  for (const g of guides) guideMap[g._id.toString()] = g;

  const sessions = await Session.find({ patient: patient._id, insuranceGuide: { $in: guides.map(g => g._id) }, status: 'completed' }).sort({ date: 1 }).lean();
  const byGuideMonth = {};
  for (const s of sessions) {
    const g = guideMap[s.insuranceGuide.toString()];
    const key = g.number + ' ' + g.specialty + ' | ' + s.date.toISOString().slice(0, 7);
    byGuideMonth[key] = (byGuideMonth[key] || 0) + 1;
  }
  console.log('Distribuicao por guia/mes:');
  for (const [k, v] of Object.entries(byGuideMonth).sort()) console.log(`  ${k}: ${v}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
