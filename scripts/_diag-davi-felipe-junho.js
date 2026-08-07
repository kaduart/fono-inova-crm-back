#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

import '../models/index.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import Package from '../models/Package.js';

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI/MONGO_URI não encontrado no .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('Conectado. Investigando Davi Felipe Araújo...\n');

  const patient = await Patient.findOne({ fullName: { $regex: 'Davi Felipe', $options: 'i' } }).lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    process.exit(0);
  }
  console.log('Paciente:', patient._id.toString(), patient.fullName, patient.phone);

  const patientId = patient._id;
  const start = new Date('2026-06-01T00:00:00-03:00');
  const end = new Date('2026-06-30T23:59:59-03:00');

  // Sessões de convênio em junho
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
  }).populate('insuranceGuide', 'number insurance specialty').lean();

  console.log('\n=== SESSÕES DE CONVÊNIO EM JUNHO/2026 ===');
  console.log('Total:', sessions.length);
  for (const s of sessions) {
    console.log({
      sessionId: s._id.toString(),
      date: s.date,
      sessionType: s.sessionType,
      specialty: s.specialty,
      billingType: s.billingType,
      paymentMethod: s.paymentMethod,
      insuranceProvider: s.insuranceProvider,
      insuranceGuide: s.insuranceGuide?.number,
      guideInsurance: s.insuranceGuide?.insurance,
      guideSpecialty: s.insuranceGuide?.specialty,
      appointmentId: s.appointmentId?.toString(),
      billingBatchId: s.billingBatchId?.toString()
    });
  }

  // Guias do paciente em junho
  const guides = await InsuranceGuide.find({
    patientId,
    $or: [
      { issuedAt: { $gte: start, $lte: end } },
      { createdAt: { $gte: start, $lte: end } }
    ]
  }).lean();

  console.log('\n=== GUIAS EMITIDAS EM JUNHO/2026 ===');
  console.log('Total:', guides.length);
  for (const g of guides) {
    console.log({
      guideId: g._id.toString(),
      number: g.number,
      insurance: g.insurance,
      specialty: g.specialty,
      issuedAt: g.issuedAt,
      createdAt: g.createdAt,
      totalSessions: g.totalSessions,
      usedSessions: g.usedSessions,
      status: g.status
    });
  }

  // Payments avulsos em junho
  const payments = await Payment.find({
    patient: patientId,
    billingType: 'convenio',
    serviceDate: { $gte: start, $lte: end }
  }).lean();

  console.log('\n=== PAYMENTS AVULSOS EM JUNHO/2026 ===');
  console.log('Total:', payments.length);
  for (const p of payments) {
    console.log({
      paymentId: p._id.toString(),
      amount: p.amount,
      serviceDate: p.serviceDate,
      serviceType: p.serviceType,
      'insurance.provider': p.insurance?.provider,
      'insurance.status': p.insurance?.status,
      sessionId: p.session?.toString(),
      appointmentId: p.appointment?.toString()
    });
  }

  // Packages de convênio do paciente
  const packages = await Package.find({ patient: patientId, type: 'convenio' }).lean();
  console.log('\n=== PACKAGES DE CONVÊNIO ===');
  console.log('Total:', packages.length);
  for (const pkg of packages) {
    console.log({
      packageId: pkg._id.toString(),
      specialty: pkg.specialty,
      insuranceProvider: pkg.insuranceProvider,
      insuranceBillingStatus: pkg.insuranceBillingStatus,
      totalSessions: pkg.totalSessions,
      usedSessions: pkg.usedSessions
    });
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
