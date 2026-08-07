import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Payment from '../models/Payment.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patient = await Patient.findOne({ fullName: { $regex: 'Davi Felipe', $options: 'i' } }).select('_id fullName cpf').lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    await mongoose.disconnect();
    return;
  }

  console.log('Paciente:', patient);
  const patientId = patient._id;

  const start = new Date(2026, 5, 1); // junho
  const end = new Date(2026, 5, 30, 23, 59, 59, 999);

  const sessions = await Session.find({
    patient: patientId,
    status: 'completed',
    date: { $gte: start, $lte: end },
    $or: [
      { billingType: 'convenio' },
      { paymentMethod: 'convenio' },
      { insuranceGuide: { $exists: true, $ne: null } },
      { paymentOrigin: 'convenio' }
    ]
  })
    .populate('doctor', 'fullName specialty')
    .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions issuedAt createdAt')
    .lean();

  console.log(`\nSessões de convênio do Davi Felipe em junho/2026: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`\n  _id=${s._id}`);
    console.log(`  date=${s.date}`);
    console.log(`  sessionType=${s.sessionType}`);
    console.log(`  billingType=${s.billingType}`);
    console.log(`  paymentMethod=${s.paymentMethod}`);
    console.log(`  paymentOrigin=${s.paymentOrigin}`);
    console.log(`  doctor=${s.doctor?.fullName} (${s.doctor?.specialty})`);
    console.log(`  insuranceGuide=${s.insuranceGuide ? JSON.stringify({ number: s.insuranceGuide.number, insurance: s.insuranceGuide.insurance, specialty: s.insuranceGuide.specialty }) : 'null'}`);
    console.log(`  appointmentId=${s.appointmentId}`);
  }

  // Todas as sessões do paciente (não só convênio) para ver se tem fisioterapia/terapia
  const allSessions = await Session.find({
    patient: patientId,
    status: 'completed',
    date: { $gte: start, $lte: end }
  })
    .populate('doctor', 'fullName specialty')
    .lean();

  console.log(`\nTodas as sessões completadas do Davi Felipe em junho/2026: ${allSessions.length}`);
  const bySpecialty = {};
  for (const s of allSessions) {
    const spec = s.sessionType || s.doctor?.specialty || 'outros';
    bySpecialty[spec] = (bySpecialty[spec] || 0) + 1;
  }
  console.log('Por especialidade:', bySpecialty);

  // Guias do paciente
  const guides = await InsuranceGuide.find({ patientId }).lean();
  console.log(`\nGuias do paciente: ${guides.length}`);
  for (const g of guides) {
    console.log(`  number=${g.number} insurance=${g.insurance} specialty=${g.specialty} issuedAt=${g.issuedAt} createdAt=${g.createdAt}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
