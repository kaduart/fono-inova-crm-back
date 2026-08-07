import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import moment from 'moment-timezone';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patientId = '69655746dcdf49e2c282800b';
  const start = moment.tz('2026-05-26', 'America/Sao_Paulo').startOf('day').toDate();
  const end = moment.tz('2026-05-26', 'America/Sao_Paulo').endOf('day').toDate();

  const sessions = await Session.find({
    patient: patientId,
    date: { $gte: start, $lte: end }
  })
    .populate('doctor', 'fullName specialty')
    .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions issuedAt createdAt')
    .lean();

  console.log(`Sessões do Nicolas em 26/05: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`\n  _id=${s._id}`);
    console.log(`  status=${s.status}`);
    console.log(`  sessionType=${s.sessionType}`);
    console.log(`  billingType=${s.billingType}`);
    console.log(`  paymentMethod=${s.paymentMethod}`);
    console.log(`  paymentOrigin=${s.paymentOrigin}`);
    console.log(`  insuranceGuide=${s.insuranceGuide ? JSON.stringify({ _id: s.insuranceGuide._id, number: s.insuranceGuide.number, insurance: s.insuranceGuide.insurance }) : 'null'}`);
    console.log(`  doctor=${s.doctor?.fullName}`);
  }

  // Busca guias do Nicolas
  const guides = await InsuranceGuide.find({ patientId }).sort({ issuedAt: 1, createdAt: 1 }).lean();
  console.log(`\nGuias do Nicolas: ${guides.length}`);
  for (const g of guides) {
    console.log(`\n  _id=${g._id}`);
    console.log(`  number=${g.number}`);
    console.log(`  insurance=${g.insurance}`);
    console.log(`  specialty=${g.specialty}`);
    console.log(`  totalSessions=${g.totalSessions}`);
    console.log(`  usedSessions=${g.usedSessions}`);
    console.log(`  issuedAt=${g.issuedAt}`);
    console.log(`  createdAt=${g.createdAt}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
