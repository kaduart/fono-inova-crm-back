import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongoUri) {
  console.error('MONGODB_URI/MONGO_URI não encontrado');
  process.exit(1);
}

await mongoose.connect(mongoUri);

const Payment = mongoose.connection.db.collection('payments');
const Appointment = mongoose.connection.db.collection('appointments');
const Patient = mongoose.connection.db.collection('patients');
const Session = mongoose.connection.db.collection('sessions');
const PatientBalance = mongoose.connection.db.collection('patientbalances');

const paymentIds = [
  '6a6919e956257ce1c0e1fa09',
  '6a6919ea56257ce1c0e1fa3d',
  '6a6919eb56257ce1c0e1fa66',
  '6a6919ec56257ce1c0e1faaa',
  '6a6919ed56257ce1c0e1fad4'
];

console.log('\n=== PAYMENTS ESPECÍFICOS ===');
const payments = await Payment.find({ _id: { $in: paymentIds.map(id => new mongoose.Types.ObjectId(id)) } }).toArray();
for (const p of payments) {
  console.log('\n--- Payment ---');
  console.log('  _id:', p._id.toString());
  console.log('  amount:', p.amount);
  console.log('  status:', p.status);
  console.log('  paymentMethod:', p.paymentMethod);
  console.log('  billingType:', p.billingType);
  console.log('  kind:', p.kind);
  console.log('  source:', p.source);
  console.log('  description:', p.description);
  console.log('  createdAt:', p.createdAt);
  console.log('  createdBy:', p.createdBy?.toString());
  console.log('  patient:', p.patient?.toString());
  console.log('  appointment:', p.appointment?.toString());
  console.log('  session:', p.session?.toString());
  console.log('  package:', p.package?.toString());
  console.log('  financialDate:', p.financialDate);
  console.log('  paymentDate:', p.paymentDate);

  if (p.patient) {
    const patient = await Patient.findOne({ _id: p.patient });
    console.log('  patient.exists:', !!patient);
    console.log('  patient:', patient);
  }
  if (p.appointment) {
    const appt = await Appointment.findOne({ _id: p.appointment });
    console.log('  appointment.exists:', !!appt);
    console.log('  appointment:', appt);
  }
}

console.log('\n=== TODOS PAYMENTS SEM PACIENTE NOMEADO EM 28/07 ===');
const start = new Date('2026-07-28T00:00:00Z');
const end = new Date('2026-07-29T00:00:00Z');
const allUnidentified = await Payment.find({
  createdAt: { $gte: start, $lte: end },
  status: 'paid',
  $or: [
    { patient: { $exists: false } },
    { patient: null }
  ]
}).toArray();

console.log('Total encontrado:', allUnidentified.length);
for (const p of allUnidentified.slice(0, 20)) {
  console.log(`  ${p._id} | R$ ${p.amount} | ${p.paymentMethod} | ${p.kind} | source=${p.source} | createdAt=${p.createdAt}`);
}

console.log('\n=== BALANCES AFETADOS ===');
for (const p of payments) {
  if (!p.patient) continue;
  const balance = await PatientBalance.findOne({ patient: p.patient });
  if (balance) {
    console.log(`PatientBalance para ${p.patient}: currentBalance=${balance.currentBalance}, tx=${balance.transactions?.length}`);
  }
}

await mongoose.disconnect();
console.log('\nDone.');
