import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const isDryRun = !process.argv.includes('--apply');
  console.log(`Modo: ${isDryRun ? 'DRY-RUN (use --apply para executar)' : 'APLICAR'}\n`);

  const patient = await db.collection('patients').findOne({ fullName: /Isabela Ferreira/i });
  if (!patient) {
    console.log('Paciente Isabela não encontrado');
    await mongoose.disconnect();
    return;
  }

  const pkg = await db.collection('packages').findOne({
    patient: patient._id,
    status: 'superseded'
  });

  if (!pkg || !pkg.insuranceGuide) {
    console.log('Package ou guide não encontrado');
    await mongoose.disconnect();
    return;
  }

  const guideId = pkg.insuranceGuide;

  const appointments = await db.collection('appointments').find({
    patient: patient._id,
    billingType: 'convenio',
    $or: [
      { insuranceGuide: { $exists: false } },
      { insuranceGuide: null }
    ]
  }).toArray();

  console.log(`Encontrados ${appointments.length} appointments para backfill`);
  console.log('Guide ID:', guideId.toString());

  if (isDryRun) {
    console.log('\n[DRY-RUN] Appointments afetados:');
    for (const apt of appointments) {
      console.log(`  ${apt._id.toString().substring(0, 8)}... date: ${apt.date}`);
    }
    await mongoose.disconnect();
    return;
  }

  // Aplicar backfill
  const result = await db.collection('appointments').updateMany(
    {
      patient: patient._id,
      billingType: 'convenio',
      $or: [
        { insuranceGuide: { $exists: false } },
        { insuranceGuide: null }
      ]
    },
    {
      $set: { insuranceGuide: guideId }
    }
  );

  console.log(`\n✅ ${result.modifiedCount} appointments atualizados com insuranceGuide`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
