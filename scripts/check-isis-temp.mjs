import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function main() {
  await mongoose.connect(MONGO_URI);
  const patientId = '685b0cfaaec14c7163585b5b';
  const patientOid = new mongoose.Types.ObjectId(patientId);
  
  const start = new Date('2026-04-27T00:00:00-03:00');
  const end = new Date('2026-05-22T23:59:59-03:00');
  
  const appointments = await Appointment.find({
    patient: patientOid,
    date: { $gte: start, $lte: end }
  }).sort({ date: 1, time: 1 }).lean();
  
  console.log('APPOINTMENTS DE 27/04 A 22/05 — ISIS CALDAS');
  console.log('Total:', appointments.length);
  console.log('');
  
  for (const appt of appointments) {
    const payments = await Payment.find({ appointment: appt._id }).lean();
    const d = new Date(appt.date).toLocaleDateString('pt-BR');
    const hasPkg = appt.package ? 'SIM' : 'NAO';
    const pkgId = appt.package ? appt.package.toString().slice(-6) : '—';
    const payStatus = payments.length > 0 ? payments.map(p => p.status).join(', ') : 'nenhum';
    console.log(d + ' ' + appt.time + ' | ' + (appt.specialty || '—') + ' | ' + appt.operationalStatus + ' | pkg:' + hasPkg + ' ' + pkgId + ' | pay:' + payStatus);
  }
  
  const bySpec = {};
  appointments.forEach(a => {
    const s = a.specialty || 'desconhecido';
    bySpec[s] = (bySpec[s] || 0) + 1;
  });
  console.log('\nPor especialidade:', JSON.stringify(bySpec));
  
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
