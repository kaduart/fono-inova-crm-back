import mongoose from 'mongoose';
const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 20000 });
const db = mongoose.connection.db;

console.log('=== ANÁLISE DO GUARD / SANITIZER ===\n');

// 1. Verificar appointments de hoje completados e seus payments
const today = new Date('2026-04-29');
const tomorrow = new Date('2026-04-30');
const appts = await db.collection('appointments').find({
  date: { $gte: today, $lt: tomorrow },
  operationalStatus: 'completed'
}).sort({ date: 1 }).toArray();

console.log('Appointments completados hoje:', appts.length);
for (const a of appts) {
  const payments = await db.collection('payments').find({ appointment: a._id }).toArray();
  const pkg = a.package ? await db.collection('packages').findOne({ _id: a.package }) : null;
  
  console.log('\n---');
  console.log('Paciente:', a.patientName || 'N/A');
  console.log('Appointment:', a._id.toString());
  console.log('billingType:', a.billingType);
  console.log('paymentStatus:', a.paymentStatus);
  console.log('isPaid:', a.isPaid);
  console.log('balanceAmount:', a.balanceAmount);
  console.log('package:', a.package?.toString(), pkg ? `(type:${pkg.type}, model:${pkg.model})` : '(sem pacote)');
  console.log('Payments:', payments.length);
  for (const p of payments) {
    console.log('  ->', p._id.toString(), 'status:', p.status, 'amount:', p.amount, 'kind:', p.kind, 'isFromPackage:', p.isFromPackage);
  }
}

// 2. Verificar como o cashflow monta transacoes vs pendentes
console.log('\n\n=== COMO O CASHFLOW CLASSIFICA ===');
console.log('transacoes = Payments do dia com status paid');
console.log('pendentesCobranca = Appointments do dia com paymentStatus != paid/package_paid/pending_receipt');
console.log('');
console.log('O GUARD seta isPaid/paymentStatus no appointmentUpdate, mas o SANITIZER');
console.log('remove esses campos no Appointment.updateOne/.findOneAndUpdate.');
console.log('Resultado: Payment eh criado como paid, mas appointment fica pending/unpaid.');
console.log('O appointment NUNCA espelha o estado do Payment.');

await mongoose.disconnect();
