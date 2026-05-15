import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  // Isabela Ferreira De Mendonca
  const patient = await db.collection('patients').findOne({ fullName: /Isabela Ferreira/i });
  if (!patient) {
    console.log('Paciente Isabela não encontrado');
    await mongoose.disconnect();
    return;
  }

  console.log('Paciente:', patient.fullName, 'ID:', patient._id.toString());

  // Package superseded da Isabela
  const pkg = await db.collection('packages').findOne({
    patient: patient._id,
    status: 'superseded'
  });

  if (!pkg) {
    console.log('Package superseded não encontrado');
    await mongoose.disconnect();
    return;
  }

  console.log('Package:', pkg._id.toString(), 'Guide:', pkg.insuranceGuide?.toString() || 'null');

  // Appointments sem insuranceGuide
  const appointments = await db.collection('appointments').find({
    patient: patient._id,
    billingType: 'convenio',
    $or: [
      { insuranceGuide: { $exists: false } },
      { insuranceGuide: null }
    ]
  }).toArray();

  console.log('\nAppointments sem insuranceGuide:', appointments.length);
  for (const apt of appointments) {
    console.log(`  ${apt._id.toString().substring(0, 8)}... date: ${apt.date}, package: ${apt.package?.toString().substring(0, 8) || 'null'}, status: ${apt.status}`);
  }

  // Verificar se o package tem insuranceGuide
  if (pkg.insuranceGuide) {
    console.log('\nGuide do package:', pkg.insuranceGuide.toString());
    
    // Verificar appointments COM insuranceGuide
    const withGuide = await db.collection('appointments').find({
      patient: patient._id,
      billingType: 'convenio',
      insuranceGuide: pkg.insuranceGuide
    }).toArray();
    console.log('Appointments COM insuranceGuide:', withGuide.length);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
