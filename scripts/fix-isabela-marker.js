import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const patient = await db.collection('patients').findOne({ fullName: /Isabela Ferreira/i });
  if (!patient) {
    console.log('Isabela não encontrada');
    await mongoose.disconnect();
    return;
  }

  const result = await db.collection('packages').updateOne(
    { patient: patient._id, status: 'superseded' },
    { $set: { migratedToInsuranceGuide: true, migratedAt: new Date(), migrationVersion: 'v2_pilot' } }
  );

  console.log('Packages atualizados:', result.modifiedCount);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
