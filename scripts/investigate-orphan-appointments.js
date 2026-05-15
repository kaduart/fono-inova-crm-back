import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const orphaned = await db.collection('appointments').find({
    billingType: 'convenio',
    $or: [
      { insuranceGuide: { $exists: false } },
      { insuranceGuide: null }
    ]
  }).toArray();

  console.log(`Total appointments sem insuranceGuide: ${orphaned.length}\n`);

  const byPackage = {};
  for (const apt of orphaned) {
    const pkgId = apt.package?.toString();
    if (!pkgId) {
      console.log(`Appointment ${apt._id.toString().substring(0,8)} sem package reference`);
      continue;
    }
    if (!byPackage[pkgId]) {
      byPackage[pkgId] = { count: 0, hasGuide: null, guideId: null, pkgStatus: null };
    }
    byPackage[pkgId].count++;
  }

  for (const pkgId of Object.keys(byPackage)) {
    const pkg = await db.collection('packages').findOne({ _id: new mongoose.Types.ObjectId(pkgId) });
    byPackage[pkgId].pkgStatus = pkg?.status || 'DELETED';
    byPackage[pkgId].hasGuide = !!pkg?.insuranceGuide;
    byPackage[pkgId].guideId = pkg?.insuranceGuide?.toString() || null;
  }

  let backfillable = 0;
  let notBackfillable = 0;

  for (const [pkgId, data] of Object.entries(byPackage)) {
    const patient = await db.collection('patients').findOne({ packages: new mongoose.Types.ObjectId(pkgId) });
    const patientName = patient?.fullName || 'N/A';
    
    if (data.hasGuide) {
      console.log(`✅ ${patientName} | Package ${pkgId.substring(0,8)} (${data.pkgStatus}) | ${data.count} apps | GUIDE: ${data.guideId.substring(0,8)} — BACKFILL POSSIVEL`);
      backfillable += data.count;
    } else {
      console.log(`❌ ${patientName} | Package ${pkgId.substring(0,8)} (${data.pkgStatus}) | ${data.count} apps | SEM GUIDE — NAO BACKFILL`);
      notBackfillable += data.count;
    }
  }

  console.log(`\nResumo: ${backfillable} backfillaveis, ${notBackfillable} nao backfillaveis`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
