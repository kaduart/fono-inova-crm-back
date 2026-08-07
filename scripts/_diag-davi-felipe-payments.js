import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patient = await Patient.findOne({ fullName: { $regex: 'Davi Felipe', $options: 'i' } }).select('_id fullName').lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    await mongoose.disconnect();
    return;
  }

  const filterYear = 2026;
  const startDate = new Date(`${filterYear}-01-01T00:00:00-03:00`);
  const endDate = new Date(`${filterYear}-12-31T23:59:59-03:00`);

  const payments = await Payment.find({
    patient: patient._id,
    billingType: 'convenio',
    package: null,
    amount: { $gt: 0 },
    'insurance.provider': { $nin: [null, '', 'Convênio', 'convenio'] },
    serviceDate: { $gte: startDate, $lte: endDate },
    status: { $nin: ['cancelled', 'canceled'] }
  })
    .populate('patient', 'fullName name phone')
    .lean();

  console.log(`Payments avulsos do Davi Felipe no ano: ${payments.length}`);

  const junePayments = payments.filter(p => {
    const d = new Date(p.serviceDate);
    return d.getFullYear() === 2026 && d.getMonth() === 5;
  });

  console.log(`Payments em junho/2026: ${junePayments.length}`);

  const apptIds = junePayments.map(p => p.appointment).filter(Boolean);
  const appts = await Appointment.find({ _id: { $in: apptIds } }).select('_id specialty').lean();
  const apptMap = Object.fromEntries(appts.map(a => [String(a._id), a]));

  for (const p of junePayments) {
    const d = new Date(p.serviceDate);
    const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const appt = p.appointment ? apptMap[String(p.appointment)] : null;
    console.log(`\nPayment ${p._id}`);
    console.log(`  serviceDate=${p.serviceDate} (${mk})`);
    console.log(`  serviceType=${p.serviceType}`);
    console.log(`  amount=${p.amount}`);
    console.log(`  insurance.provider=${p.insurance?.provider}`);
    console.log(`  insurance.status=${p.insurance?.status}`);
    console.log(`  appointment=${p.appointment}`);
    console.log(`  session=${p.session}`);
    console.log(`  appointment.specialty=${appt?.specialty}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
