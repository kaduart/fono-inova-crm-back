import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const patientId = '69bd82b8272d184895f454aa';
  const pkgId = '69d3107ba14c560c7eb92aca';

  const patient = await db.collection('patients').findOne({ _id: new mongoose.Types.ObjectId(patientId) });
  console.log('Paciente direto:', patient ? 'ENCONTRADO' : 'NAO ENCONTRADO');

  const patient2 = await db.collection('patients').findOne({ _id: patientId });
  console.log('Paciente string:', patient2 ? 'ENCONTRADO' : 'NAO ENCONTRADO');

  const appointments = await db.collection('appointments').find({
    package: new mongoose.Types.ObjectId(pkgId)
  }).toArray();
  console.log('Appointments do package orfao:', appointments.length);

  const sessions = await db.collection('sessions').find({
    package: new mongoose.Types.ObjectId(pkgId)
  }).toArray();
  console.log('Sessions do package orfao:', sessions.length);
  console.log('Sessions status:', sessions.map(s => s.status));

  const pkg = await db.collection('packages').findOne({ _id: new mongoose.Types.ObjectId(pkgId) });
  if (pkg && pkg.payments?.length > 0) {
    const paymentIds = pkg.payments.map(id => typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id);
    const payments = await db.collection('payments').find({
      _id: { $in: paymentIds }
    }).toArray();
    console.log('Payments do package orfao:', payments.length);
    console.log('Payments amounts:', payments.map(p => ({ amount: p.amount, status: p.status, billingType: p.billingType })));
  } else {
    console.log('Sem payments no package');
  }

  // Verificar se o paciente existe como deleted
  const deletedPatient = await db.collection('patients').findOne({ 
    $or: [
      { _id: new mongoose.Types.ObjectId(patientId) },
      { originalId: patientId }
    ]
  });
  console.log('Paciente (qualquer forma):', deletedPatient ? 'ENCONTRADO' : 'NAO ENCONTRADO');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
