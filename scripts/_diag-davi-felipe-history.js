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
import Package from '../models/Package.js';

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

  const provider = null;
  const batchBaseFilter = {};
  const pkgFilter = { type: 'convenio' };
  const avulsoFilter = {
    billingType: 'convenio',
    package: null,
    amount: { $gt: 0 },
    'insurance.provider': { $nin: [null, '', 'Convênio', 'convenio'] },
    serviceDate: { $gte: startDate, $lte: endDate },
    status: { $nin: ['cancelled', 'canceled'] }
  };
  const guideFilter = { $or: [
    { issuedAt: { $gte: startDate, $lte: endDate } },
    { issuedAt: null, createdAt: { $gte: startDate, $lte: endDate } }
  ] };

  const [batches, packages, avulsoPayments, guidesInYear] = await Promise.all([
    InsuranceBatch.find(batchBaseFilter).lean(),
    Package.find(pkgFilter).populate('patient', 'fullName name phone').lean(),
    Payment.find(avulsoFilter).populate('patient', 'fullName name phone').lean(),
    InsuranceGuide.find(guideFilter).populate('patientId', 'fullName name phone').lean()
  ]);

  console.log(`Batches no ano: ${batches.length}`);
  console.log(`Packages no ano: ${packages.length}`);
  console.log(`AvulsoPayments no ano: ${avulsoPayments.length}`);
  console.log(`Guides no ano: ${guidesInYear.length}`);

  const guideIds = guidesInYear.map(g => g._id);
  const guideSessions = guideIds.length
    ? await Session.find({
        insuranceGuide: { $in: guideIds },
        status: 'completed',
        patient: patient._id
      })
      .populate('patient', 'fullName name phone')
      .populate('doctor', 'fullName specialty')
      .lean()
    : [];

  console.log(`\nGuideSessions do Davi Felipe no ano: ${guideSessions.length}`);
  const juneGuideSessions = guideSessions.filter(s => {
    const d = new Date(s.date);
    return d.getFullYear() === 2026 && d.getMonth() === 5;
  });
  console.log(`GuideSessions do Davi Felipe em junho/2026: ${juneGuideSessions.length}`);
  for (const s of juneGuideSessions) {
    const guide = guidesInYear.find(g => String(g._id) === String(s.insuranceGuide));
    console.log(`  ${s._id} ${s.date} sessionType=${s.sessionType} guide=${guide?.number} guide.specialty=${guide?.specialty}`);
  }

  // Verifica countedSessionIds para as sessões de junho
  const countedSessionIds = new Set();
  for (const batch of batches) {
    for (const s of (batch.sessions || [])) {
      if (s.session) countedSessionIds.add(String(s.session));
    }
  }
  for (const pmt of avulsoPayments) {
    if (pmt.session) countedSessionIds.add(String(pmt.session));
  }
  for (const pkg of packages) {
    for (const apptId of (pkg.appointments || [])) {
      countedSessionIds.add(String(apptId));
    }
  }

  console.log('\nVerificando se sessões de junho estão em countedSessionIds:');
  for (const s of juneGuideSessions) {
    console.log(`  ${s._id} sessionType=${s.sessionType} counted=${countedSessionIds.has(String(s._id))}`);
  }

  // Guias do Davi Felipe em junho/2026
  const patientGuides = guidesInYear.filter(g => String(g.patientId?._id || g.patientId) === String(patient._id));
  console.log(`\nGuias do Davi Felipe no ano: ${patientGuides.length}`);
  for (const g of patientGuides) {
    const createdAt = g.createdAt;
    const isJune = createdAt >= startDate && createdAt <= endDate && createdAt.getMonth() === 5 && createdAt.getFullYear() === 2026;
    console.log(`  ${g.number} ${g.specialty} createdAt=${createdAt} ${isJune ? '<-- JUNHO' : ''}`);
  }

  // Packages do Davi Felipe
  const patientPackages = packages.filter(p => String(p.patient?._id || p.patient) === String(patient._id));
  console.log(`\nPackages do Davi Felipe: ${patientPackages.length}`);
  for (const p of patientPackages) {
    console.log(`  ${p._id} specialty=${p.specialty} appointments=${p.appointments?.length || 0}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
