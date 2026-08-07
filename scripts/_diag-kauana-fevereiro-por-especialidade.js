import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id fullName').lean();
  const startFeb = new Date('2026-02-01T00:00:00-03:00');
  const endFeb = new Date('2026-02-29T23:59:59-03:00');

  const sessions = await Session.find({
    patient: patient._id,
    status: 'completed',
    date: { $gte: startFeb, $lte: endFeb }
  })
    .populate('insuranceGuide', 'number insurance specialty')
    .populate('appointmentId', 'time')
    .populate('doctor', 'fullName specialty')
    .sort({ date: 1, 'appointmentId.time': 1 })
    .lean();

  console.log(`Sessões de fev/2026: ${sessions.length}\n`);

  const bySpecialty = {};
  for (const s of sessions) {
    const appt = await Appointment.findById(s.appointmentId?._id).select('specialty').lean();
    const specialty = appt?.specialty || s.specialty || s.sessionType || 'outros';
    const payments = await Payment.find({ session: s._id }).lean();
    const bestPayment = payments.sort((a, b) => {
      const rank = { received: 3, billed: 2, pending_billing: 1, pending: 1 };
      return (rank[b.insurance?.status] || 0) - (rank[a.insurance?.status] || 0);
    })[0];
    const batch = s.billingBatchId ? await InsuranceBatch.findById(s.billingBatchId).select('sentDate status').lean() : null;

    if (!bySpecialty[specialty]) bySpecialty[specialty] = [];
    bySpecialty[specialty].push({
      date: s.date.toISOString(),
      time: s.appointmentId?.time,
      doctor: s.doctor?.fullName,
      specialty,
      guide: s.insuranceGuide?.number || '-',
      guideSpecialty: s.insuranceGuide?.specialty || '-',
      sessionValue: s.sessionValue,
      paymentAmount: bestPayment?.amount || 0,
      paymentInsuranceStatus: bestPayment?.insurance?.status || '-',
      paymentStatus: bestPayment?.status || '-',
      billingBatchId: s.billingBatchId?.toString() || null,
      batchSentDate: batch?.sentDate?.toISOString?.() || null,
      sessionId: s._id.toString()
    });
  }

  let grandTotal = 0;
  let grandSessions = 0;

  for (const [specialty, list] of Object.entries(bySpecialty).sort()) {
    const totalValue = list.reduce((sum, s) => sum + (s.paymentAmount || 0), 0);
    console.log(`\n=== ${specialty} === ${list.length} sessões | R$ ${totalValue.toFixed(2)}`);
    grandTotal += totalValue;
    grandSessions += list.length;
    for (const s of list) {
      const status = s.billingBatchId ? `Faturado (${s.batchSentDate?.slice(0,10) || 'sem data'})` : (s.paymentInsuranceStatus === 'billed' ? 'Billed sem lote' : 'Aguardando Lote');
      console.log(`  ${s.date.slice(0,10)} ${s.time} | ${s.doctor} | guia ${s.guide} (${s.guideSpecialty}) | R$ ${s.paymentAmount} | ${status} | sessionValue:${s.sessionValue}`);
    }
  }

  console.log(`\n=== TOTAL === ${grandSessions} sessões | R$ ${grandTotal.toFixed(2)}`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
