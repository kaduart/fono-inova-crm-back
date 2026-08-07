import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Payment from '../models/Payment.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const filterYear = 2026;
  const startDate = new Date(`${filterYear}-07-01T00:00:00-03:00`);
  const endDate = new Date(`${filterYear}-07-31T23:59:59-03:00`);

  console.log('=== Bradesco Saúde - Julho/2026 ===\n');

  // 1. Batches Bradesco Saúde em julho
  const batches = await InsuranceBatch.find({
    insuranceProvider: 'bradesco-saude',
    startDate: { $gte: startDate, $lte: endDate }
  }).lean();
  console.log(`Batches: ${batches.length}`);
  for (const b of batches) {
    console.log(`  ${b._id} ${b.batchNumber} status=${b.status} sessions=${b.sessions?.length}`);
  }

  // 2. Payments avulsos Bradesco Saúde em julho
  const payments = await Payment.find({
    billingType: 'convenio',
    package: null,
    amount: { $gt: 0 },
    'insurance.provider': 'bradesco-saude',
    serviceDate: { $gte: startDate, $lte: endDate },
    status: { $nin: ['cancelled', 'canceled'] }
  })
    .populate('patient', 'fullName name phone')
    .lean();
  console.log(`\nPayments avulsos bradesco-saude: ${payments.length}`);
  for (const p of payments) {
    console.log(`  ${p._id} patient=${p.patient?.fullName || p.patient?.name || 'null'} amount=${p.amount} serviceDate=${p.serviceDate} appointment=${p.appointment} session=${p.session}`);
  }

  // 3. Guias Bradesco Saúde com competência julho
  const guides = await InsuranceGuide.find({
    insurance: 'bradesco-saude',
    $or: [
      { issuedAt: { $gte: startDate, $lte: endDate } },
      { issuedAt: null, createdAt: { $gte: startDate, $lte: endDate } }
    ]
  }).populate('patientId', 'fullName name phone').lean();
  console.log(`\nGuias bradesco-saude competência julho: ${guides.length}`);
  for (const g of guides) {
    console.log(`  ${g._id} number=${g.number} patientId=${g.patientId?._id} ${g.patientId?.fullName || g.patientId?.name || 'null'}`);
  }

  // 4. Sessões das guias
  const guideIds = guides.map(g => g._id);
  const sessions = guideIds.length
    ? await Session.find({ insuranceGuide: { $in: guideIds }, status: 'completed' })
        .populate('patient', 'fullName name phone')
        .lean()
    : [];
  console.log(`\nSessões das guias: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`  ${s._id} patient=${s.patient?.fullName || s.patient?.name || 'null'} date=${s.date} appointmentId=${s.appointmentId}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
