import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Package from './models/Package.js';
import Session from './models/Session.js';

dotenv.config();

const badIds = [
  '69dd337beddcc1fcb0275468',
  '69dd337ceddcc1fcb0275486',
  '69dd337ceddcc1fcb0275495',
  '69dd34d089db10d7c3aec866',
  '69dd35876ed4802c9c642035',
  '69dd35d846be62fbfa2bd07d'
];

try {
  await mongoose.connect(process.env.MONGO_URI);
  for (const id of badIds) {
    const pkg = await Package.findById(id).lean();
    const sessions = await Session.find({ package: id }).select('date time status').lean();
    console.log(`\nPackage ${id}`);
    console.log(`  pkg.date: ${pkg?.date}`);
    console.log(`  sessions: ${sessions.length}`);
    sessions.forEach(s => {
      console.log(`    - ${s._id} | date:"${s.date}" | time:"${s.time}" | status:${s.status}`);
    });
  }
} finally {
  await mongoose.disconnect();
}
