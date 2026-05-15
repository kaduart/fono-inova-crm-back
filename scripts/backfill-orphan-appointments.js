import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const isDryRun = !process.argv.includes('--apply');
  console.log(`Modo: ${isDryRun ? 'DRY-RUN (use --apply para executar)' : 'APLICAR'}\n`);

  const orphaned = await db.collection('appointments').find({
    billingType: 'convenio',
    $or: [
      { insuranceGuide: { $exists: false } },
      { insuranceGuide: null }
    ]
  }).toArray();

  console.log(`Total appointments sem insuranceGuide: ${orphaned.length}\n`);

  // Agrupar por package
  const byPackage = {};
  for (const apt of orphaned) {
    const pkgId = apt.package?.toString();
    if (!pkgId) continue;
    if (!byPackage[pkgId]) byPackage[pkgId] = [];
    byPackage[pkgId].push(apt._id);
  }

  let totalUpdated = 0;

  for (const [pkgId, aptIds] of Object.entries(byPackage)) {
    const pkg = await db.collection('packages').findOne({ _id: new mongoose.Types.ObjectId(pkgId) });
    if (!pkg?.insuranceGuide) {
      console.log(`SKIP Package ${pkgId.substring(0,8)} — sem insuranceGuide`);
      continue;
    }

    const guideId = pkg.insuranceGuide;
    console.log(`Package ${pkgId.substring(0,8)} → Guide ${guideId.toString().substring(0,8)} (${aptIds.length} appointments)`);

    if (!isDryRun) {
      const result = await db.collection('appointments').updateMany(
        { _id: { $in: aptIds.map(id => typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id) } },
        { $set: { insuranceGuide: guideId } }
      );
      totalUpdated += result.modifiedCount;
    }
  }

  console.log(`\n${isDryRun ? '[DRY-RUN] ' : ''}Total: ${totalUpdated} appointments atualizados`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
