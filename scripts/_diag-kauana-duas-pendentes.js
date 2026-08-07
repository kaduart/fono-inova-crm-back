import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id fullName').lean();
  const guide2028 = await InsuranceGuide.findOne({ number: '2028', patientId: patient._id }).lean();
  if (!guide2028) {
    console.log('Guia 2028 não encontrada');
    await mongoose.disconnect();
    return;
  }

  console.log('Guia 2028:', guide2028._id.toString(), 'status:', guide2028.status, 'billingMode:', guide2028.billingMode);

  // Sessões pendentes da guia 2028
  const pendingSessions = await Session.find({
    patient: patient._id,
    insuranceGuide: guide2028._id,
    status: 'completed',
    $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }]
  })
    .populate('appointmentId', 'time')
    .populate('doctor', 'fullName specialty')
    .sort({ date: 1 })
    .lean();

  console.log(`\n=== Sessões pendentes na guia 2028 === ${pendingSessions.length}`);
  for (const s of pendingSessions) {
    const payments = await Payment.find({ session: s._id }).lean();
    console.log(`\nSessão ${s._id.toString()}`);
    console.log(`  date: ${s.date.toISOString()} | time: ${s.appointmentId?.time} | specialty: ${s.specialty || s.sessionType}`);
    console.log(`  doctor: ${s.doctor?.fullName}`);
    console.log(`  sessionValue: ${s.sessionValue}`);
    console.log(`  billingType: ${s.billingType} | paymentMethod: ${s.paymentMethod} | paymentOrigin: ${s.paymentOrigin}`);
    console.log(`  billingBatchId: ${s.billingBatchId}`);
    console.log(`  Payments (${payments.length}):`);
    for (const p of payments) {
      console.log(`    - ${p._id.toString()} | status:${p.status} | billingType:${p.billingType} | amount:${p.amount} | insurance.status:${p.insurance?.status} | insurance.provider:${p.insurance?.provider} | session:${p.session?.toString()}`);
    }

    // Verificar se appointment está cancelado
    if (s.appointmentId) {
      const appt = await Appointment.findById(s.appointmentId._id).lean();
      console.log(`  Appointment status: ${appt?.status} | date: ${appt?.date?.toISOString?.()} | time: ${appt?.time}`);
    }
  }

  // Lotes da guia 2028
  const batches = await InsuranceBatch.find({ 'sessions.guide': guide2028._id }).lean();
  console.log(`\n=== Lotes com guia 2028 === ${batches.length}`);
  for (const b of batches) {
    console.log(`\nLote ${b.batchNumber} (${b._id}) | status:${b.status} | sentDate:${b.sentDate?.toISOString?.()}`);
    for (const bs of b.sessions.filter(bs => bs.guide?.toString() === guide2028._id.toString())) {
      const session = await Session.findById(bs.session).select('date appointmentId').populate('appointmentId', 'time').lean();
      console.log(`  - ${bs.session.toString()} | ${session?.date?.toISOString?.()} ${session?.appointmentId?.time} | gross:${bs.grossAmount} | status:${bs.status}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
