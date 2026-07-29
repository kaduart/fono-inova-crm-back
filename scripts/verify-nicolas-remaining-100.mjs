import 'dotenv/config';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGO_URI);
await import('../models/PatientsView.js');
await import('../models/Patient.js');
await import('../models/Doctor.js');
const Payment = (await import('../models/Payment.js')).default;
const Appointment = (await import('../models/Appointment.js')).default;

const patientId = '69655746dcdf49e2c282800b';
const p100 = await Payment.find({ patient: patientId, $or: [{ amount: 100 }, { 'insurance.grossAmount': 100 }] }).lean();
const a100 = await Appointment.find({ patient: patientId, $or: [{ sessionValue: 100 }, { insuranceValue: 100 }] }).lean();

console.log('Payments com 100:', p100.length);
console.log('Appointments com 100:', a100.length);
if (p100.length > 0) {
  p100.forEach(p => console.log(`  ${p._id} | amount:${p.amount} gross:${p.insurance?.grossAmount} | ${p.paymentDate?.toISOString().slice(0, 10)}`));
}
if (a100.length > 0) {
  a100.forEach(a => console.log(`  ${a._id} | sessionValue:${a.sessionValue} insuranceValue:${a.insuranceValue} | ${a.date?.toISOString().slice(0, 10)}`));
}
await mongoose.disconnect();
