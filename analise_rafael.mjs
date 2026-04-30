import mongoose from 'mongoose';
const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 20000 });
const db = mongoose.connection.db;

console.log('=== RAFAEL BARROS SANTOS - DETALHES ===\n');

const appt = await db.collection('appointments').findOne({ _id: new mongoose.Types.ObjectId('69e8c8eae52ed393a2581304') });
const pkg = appt?.package ? await db.collection('packages').findOne({ _id: appt.package }) : null;
const patient = appt?.patient ? await db.collection('patients').findOne({ _id: appt.patient }) : null;

console.log('Paciente:', patient?.name, patient?.phone);
console.log('');
console.log('Appointment:');
console.log('  billingType:', appt.billingType);
console.log('  paymentStatus:', appt.paymentStatus);
console.log('  isPaid:', appt.isPaid);
console.log('  balanceAmount:', appt.balanceAmount);
console.log('  paymentMethod:', appt.paymentMethod);
console.log('  package:', appt.package?.toString());
console.log('');
console.log('Package:');
console.log('  type:', pkg?.type);
console.log('  model:', pkg?.model);
console.log('  paymentType:', pkg?.paymentType);
console.log('  totalValue:', pkg?.totalValue);
console.log('  totalPaid:', pkg?.totalPaid);
console.log('  balance:', pkg?.balance);
console.log('  sessionsDone:', pkg?.sessionsDone);
console.log('  totalSessions:', pkg?.totalSessions);
console.log('');
console.log('CONCLUSÃO:');
if (pkg?.model === 'per_session' || pkg?.paymentType === 'per-session') {
  console.log('  Rafael tem pacote PER-SESSION (paga cada sessão individualmente).');
  console.log('  O completeSessionV2 criou um Payment de R$ 180 para ele.');
  console.log('  EU DELETEI esse Payment. Agora ele está sem pagamento.');
  console.log('  O appointment dele está unpaid com balance 180.');
} else {
  console.log('  Pacote é pré-pago. Não deveria ter balance.');
}

await mongoose.disconnect();
