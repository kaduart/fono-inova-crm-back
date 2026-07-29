import 'dotenv/config';
import mongoose from 'mongoose';
import '../models/PatientsView.js';
import '../models/Patient.js';
import '../models/Doctor.js';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI não definido'); process.exit(1); }

  const dryRun = !process.argv.includes('--apply');
  const args = process.argv.filter(a => a !== '--apply');

  const patientId = args[2];
  const guideNumber = args[3];
  const fromValue = Number(args[4] || 100);
  const toValue = Number(args[5] || 80);

  if (!patientId || !guideNumber) {
    console.error('Uso: node fix-patient-guide-100-to-80.mjs <patientId> <guideNumber> [fromValue] [toValue] [--apply]');
    process.exit(1);
  }

  console.log(`🚀 Conectando ao MongoDB (${dryRun ? 'DRY-RUN' : 'APLICANDO'})`);
  console.log(`Paciente: ${patientId} | Guia: ${guideNumber} | ${fromValue} → ${toValue}\n`);

  await mongoose.connect(uri);

  const Appointment = (await import('../models/Appointment.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  const guide = await InsuranceGuide.findOne({ number: guideNumber }).lean();
  if (!guide) { console.log(`Guia ${guideNumber} não encontrada`); await mongoose.disconnect(); return; }

  console.log(`Guia ${guideNumber} encontrada: sessionValue=${guide.sessionValue}, usedSessions=${guide.usedSessions}/${guide.totalSessions}, status=${guide.status}`);

  const appointments = await Appointment.find({
    patient: patientId,
    insuranceGuide: guide._id,
    $or: [
      { sessionValue: fromValue },
      { insuranceValue: fromValue }
    ]
  }).lean();

  console.log(`\nAppointments com valor ${fromValue}: ${appointments.length}`);
  for (const a of appointments) {
    console.log(`  ${a._id} | ${a.date?.toISOString().slice(0, 10)} ${a.time} | sessionValue: ${a.sessionValue} | insuranceValue: ${a.insuranceValue}`);
    if (!dryRun) {
      const update = {};
      if (a.sessionValue === fromValue) update.sessionValue = toValue;
      if (a.insuranceValue === fromValue) update.insuranceValue = toValue;
      await Appointment.updateOne({ _id: a._id }, { $set: update });
    }
  }

  const sessions = await Session.find({
    patient: patientId,
    insuranceGuide: guide._id,
    $or: [
      { sessionValue: fromValue },
      { value: fromValue }
    ]
  }).lean();

  console.log(`\nSessions com valor ${fromValue}: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`  ${s._id} | ${s.date?.toISOString().slice(0, 10)} ${s.time} | sessionValue: ${s.sessionValue} | value: ${s.value}`);
    if (!dryRun) {
      const update = {};
      if (s.sessionValue === fromValue) update.sessionValue = toValue;
      if (s.value === fromValue) update.value = toValue;
      await Session.updateOne({ _id: s._id }, { $set: update });
    }
  }

  const sessionIds = sessions.map(s => s._id);
  const payments = await Payment.find({
    patient: patientId,
    $or: [
      { session: { $in: sessionIds } },
      { appointment: { $in: appointments.map(a => a._id) } },
      { 'insurance.guide': guide._id },
      { 'insurance.guideNumber': guideNumber }
    ],
    $or: [
      { amount: fromValue },
      { 'insurance.grossAmount': fromValue }
    ]
  }).lean();

  console.log(`\nPayments com valor ${fromValue}: ${payments.length}`);
  for (const p of payments) {
    console.log(`  ${p._id} | ${p.paymentDate?.toISOString().slice(0, 10)} | amount: ${p.amount} | grossAmount: ${p.insurance?.grossAmount} | status: ${p.status}`);
    if (!dryRun) {
      const update = {};
      if (p.amount === fromValue) update.amount = toValue;
      if (p.insurance?.grossAmount === fromValue) update['insurance.grossAmount'] = toValue;
      await Payment.updateOne({ _id: p._id }, { $set: update });
    }
  }

  if (guide.sessionValue === fromValue) {
    console.log(`\nInsuranceGuide ${guideNumber}: sessionValue ${guide.sessionValue} → ${toValue}`);
    if (!dryRun) {
      await InsuranceGuide.updateOne({ _id: guide._id }, { $set: { sessionValue: toValue } });
    }
  }

  await mongoose.disconnect();
  console.log(`\n${dryRun ? 'DRY-RUN finalizado. Use --apply para executar.' : 'Alterações aplicadas.'}`);
  console.log('🔌 Desconectado.');
}

main().catch(err => { console.error('Erro fatal:', err); process.exit(1); });
