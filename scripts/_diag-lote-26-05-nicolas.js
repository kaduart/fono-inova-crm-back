import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id fullName').lean();
  const guide = await InsuranceGuide.findOne({ number: '15650187', patientId: patient._id }).select('_id').lean();
  if (!guide) {
    console.log('Guia 15650187 não encontrada');
    await mongoose.disconnect();
    return;
  }

  const session = await Session.findOne({
    patient: patient._id,
    insuranceGuide: guide._id,
    status: 'completed',
    date: { $gte: new Date('2026-05-01T00:00:00-03:00'), $lte: new Date('2026-05-31T23:59:59-03:00') }
  }).lean();

  if (!session) {
    console.log('Sessão de 26/05 não encontrada');
    await mongoose.disconnect();
    return;
  }

  console.log('Sessão encontrada:', session._id.toString());
  console.log('date:', session.date.toISOString());
  console.log('billingBatchId:', session.billingBatchId?.toString());

  if (session.billingBatchId) {
    const batch = await InsuranceBatch.findById(session.billingBatchId).lean();
    console.log('Batch status:', batch?.status);
    console.log('Batch sentAt:', batch?.sentAt);
    console.log('Batch:', JSON.stringify(batch, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
