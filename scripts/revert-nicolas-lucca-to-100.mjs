import 'dotenv/config';
import mongoose from 'mongoose';
import '../models/PatientsView.js';
import '../models/Patient.js';
import '../models/Doctor.js';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI não definido'); process.exit(1); }

  const dryRun = !process.argv.includes('--apply');
  console.log(`🚀 Conectando ao MongoDB (${dryRun ? 'DRY-RUN' : 'APLICANDO ALTERAÇÕES'})\n`);

  await mongoose.connect(uri);

  const Appointment = (await import('../models/Appointment.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  const patientId = '69655746dcdf49e2c282800b';
  const CORRECT_VALUE = 100;
  const WRONG_VALUE = 80;

  // 1. Appointments do Nicolas Lucca com sessionValue ou insuranceValue 80
  const appointments = await Appointment.find({
    patient: patientId,
    $or: [
      { sessionValue: WRONG_VALUE },
      { insuranceValue: WRONG_VALUE }
    ]
  }).lean();

  console.log(`Appointments com valor ${WRONG_VALUE}: ${appointments.length}`);
  const guideIdsToCheck = new Set();
  for (const a of appointments) {
    console.log(`  ${a._id} | date: ${a.date?.toISOString().slice(0, 10)} | time: ${a.time} | sessionValue: ${a.sessionValue} | insuranceValue: ${a.insuranceValue} | specialty: ${a.specialty}`);
    if (a.insuranceGuide) guideIdsToCheck.add(a.insuranceGuide.toString());
    if (!dryRun) {
      const update = {};
      if (a.sessionValue === WRONG_VALUE) update.sessionValue = CORRECT_VALUE;
      if (a.insuranceValue === WRONG_VALUE) update.insuranceValue = CORRECT_VALUE;
      await Appointment.updateOne({ _id: a._id }, { $set: update });
    }
  }

  // 2. Payments do Nicolas Lucca com amount ou insurance.grossAmount 80
  const payments = await Payment.find({
    patient: patientId,
    $or: [
      { amount: WRONG_VALUE },
      { 'insurance.grossAmount': WRONG_VALUE }
    ]
  }).lean();

  console.log(`\nPayments com valor ${WRONG_VALUE}: ${payments.length}`);
  for (const p of payments) {
    console.log(`  ${p._id} | amount: ${p.amount} | grossAmount: ${p.insurance?.grossAmount} | status: ${p.status} | paymentDate: ${p.paymentDate?.toISOString().slice(0, 10)}`);
    if (!dryRun) {
      const update = {};
      if (p.amount === WRONG_VALUE) update.amount = CORRECT_VALUE;
      if (p.insurance?.grossAmount === WRONG_VALUE) update['insurance.grossAmount'] = CORRECT_VALUE;
      await Payment.updateOne({ _id: p._id }, { $set: update });
    }
  }

  // 3. Guias usadas por esses appointments com sessionValue 80
  if (guideIdsToCheck.size > 0) {
    const guides = await InsuranceGuide.find({
      _id: { $in: Array.from(guideIdsToCheck).map(id => new mongoose.Types.ObjectId(id)) },
      sessionValue: WRONG_VALUE
    }).lean();

    console.log(`\nInsuranceGuides com sessionValue ${WRONG_VALUE}: ${guides.length}`);
    for (const g of guides) {
      console.log(`  ${g._id} | number: ${g.number} | patient: ${g.patient} | sessionValue: ${g.sessionValue}`);
      if (!dryRun) {
        await InsuranceGuide.updateOne({ _id: g._id }, { $set: { sessionValue: CORRECT_VALUE } });
      }
    }
  }

  await mongoose.disconnect();
  console.log(`\n${dryRun ? 'DRY-RUN finalizado. Use --apply para executar.' : 'Alterações aplicadas.'}`);
  console.log('🔌 Desconectado.');
}

main().catch(err => { console.error('Erro fatal:', err); process.exit(1); });
