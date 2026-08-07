import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id fullName').lean();
  const guide2027 = await InsuranceGuide.findOne({ number: '2027', patientId: patient._id }).lean();

  const pendingSessions = await Session.find({
    patient: patient._id,
    insuranceGuide: guide2027._id,
    status: 'completed',
    $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }]
  })
    .populate('appointmentId', 'time')
    .populate('doctor', 'fullName')
    .sort({ date: 1 })
    .lean();

  console.log(`Guia 2027 pendentes: ${pendingSessions.length}`);
  for (const s of pendingSessions) {
    const payments = await Payment.find({ session: s._id }).lean();
    const statuses = payments.map(p => `${p.status}/${p.insurance?.status || '-'}`).join(', ');
    console.log(`${s.date.toISOString()} ${s.appointmentId?.time} | ${s.specialty || s.sessionType} | ${s.doctor?.fullName} | sessionValue:${s.sessionValue} | billingBatchId:${s.billingBatchId} | payments: ${statuses}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
