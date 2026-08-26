import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Patient from './models/Patient.js';
import Appointment from './models/Appointment.js';
import Session from './models/Session.js';
import Payment from './models/Payment.js';
import Package from './models/Package.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const patient = await Patient.findOne({ fullName: /Danilo Miguel de Oliveira/i }).lean();
  console.log('Patient:', patient._id.toString());

  // O appointment/payment pendente que já conhecemos
  const pay = await Payment.findById('68e3d3890d8aeeff1af04264').lean();
  console.log('\nPayment em disputa:', JSON.stringify({ amount: pay.amount, status: pay.status, appointment: pay.appointment, kind: pay.kind, createdAt: pay.createdAt }, null, 2));

  const appt = await Appointment.findById(pay.appointment).lean();
  console.log('\nAppointment em disputa:', JSON.stringify({
    date: appt.date, time: appt.time, serviceType: appt.serviceType, package: appt.package,
    operationalStatus: appt.operationalStatus, session: appt.session, history: appt.history, createdAt: appt.createdAt
  }, null, 2));

  // Qualquer outro appointment do paciente na MESMA data (independente de horário)
  const sameDay = await Appointment.find({
    patient: patient._id,
    date: { $gte: new Date(new Date(appt.date).setUTCHours(0,0,0,0)), $lt: new Date(new Date(appt.date).setUTCHours(23,59,59,999)) }
  }).lean();
  console.log(`\nTodos appointments do paciente na mesma data (${sameDay.length}):`);
  for (const a of sameDay) {
    console.log({ id: a._id.toString(), time: a.time, serviceType: a.serviceType, package: a.package?.toString(), operationalStatus: a.operationalStatus });
  }

  // Pacotes do paciente e datas de criação (via ObjectId)
  const packages = await Package.find({ patient: patient._id }).lean();
  console.log('\nPacotes do paciente:');
  for (const p of packages) {
    console.log({ id: p._id.toString(), sessionType: p.sessionType, totalSessions: p.totalSessions, sessionsDone: p.sessionsDone, createdAt_viaObjectId: p._id.getTimestamp(), status: p.status });
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
