import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id fullName').lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    await mongoose.disconnect();
    return;
  }
  console.log('Paciente:', patient.fullName, patient._id.toString());

  // Todas as sessões de maio/2026 do paciente
  const startMay = new Date('2026-05-01T00:00:00-03:00');
  const endMay = new Date('2026-05-31T23:59:59-03:00');
  const maySessions = await Session.find({
    patient: patient._id,
    status: 'completed',
    date: { $gte: startMay, $lte: endMay }
  })
    .populate('insuranceGuide', 'number insurance billingMode')
    .populate('doctor', 'fullName specialty')
    .populate('appointmentId', 'time')
    .sort({ date: 1 })
    .lean();

  console.log(`\n=== Todas as sessões de maio/2026 (filtro local -03:00) === ${maySessions.length}`);
  for (const s of maySessions) {
    const payments = await Payment.find({ session: s._id }).select('status insurance.status amount insurance.grossAmount').lean();
    console.log(`${s.date.toISOString()} | time:${s.appointmentId?.time} | ${s.specialty || '-'} | ${s.insuranceGuide ? 'guia ' + s.insuranceGuide.number : 'sem guia'} | billingBatchId:${s.billingBatchId} | sessionValue:${s.sessionValue} | payments:${payments.map(p => p.status || p.insurance?.status).join('/') || 'nenhum'}`);
  }

  // Todas as sessões da guia 15650187 (sem filtro de mês)
  const guide15650187 = await InsuranceGuide.findOne({ number: '15650187', patientId: patient._id }).lean();
  if (guide15650187) {
    console.log('\n=== Guia 15650187 ===');
    console.log('guide._id:', guide15650187._id.toString());
    console.log('guide.number:', guide15650187.number);
    console.log('guide.insurance:', guide15650187.insurance);
    console.log('guide.billingMode:', guide15650187.billingMode);
    console.log('guide.issuedAt:', guide15650187.issuedAt?.toISOString?.());
    console.log('guide.totalSessions:', guide15650187.totalSessions);
    console.log('guide.usedSessions:', guide15650187.usedSessions);
    console.log('guide.sessionValue:', guide15650187.sessionValue);
    console.log('guide.status:', guide15650187.status);
    console.log('guide.closedAt:', guide15650187.closedAt);

    const guideSessions = await Session.find({
      insuranceGuide: guide15650187._id,
      status: 'completed'
    })
      .populate('appointmentId', 'time')
      .populate('doctor', 'fullName')
      .sort({ date: 1 })
      .lean();

    console.log(`\n=== Todas as sessões da guia 15650187 === ${guideSessions.length}`);
    for (const s of guideSessions) {
      const payments = await Payment.find({ session: s._id }).select('status insurance.status amount insurance.grossAmount').lean();
      console.log(`${s.date.toISOString()} | time:${s.appointmentId?.time} | ${s.specialty || '-'} | doctor:${s.doctor?.fullName} | billingBatchId:${s.billingBatchId} | sessionValue:${s.sessionValue} | payments:${payments.map(p => p.status || p.insurance?.status).join('/') || 'nenhum'}`);
    }
  } else {
    console.log('\nGuia 15650187 não encontrada para este paciente');
  }

  // Simulação do listGuidesPendingBilling(month=2026-05)
  const month = '2026-05';
  const [y, m] = month.split('-').map(Number);
  const periodStart = new Date(y, m - 1, 1);
  const periodEnd = new Date(y, m, 0, 23, 59, 59, 999);

  console.log('\n=== Simulação listGuidesPendingBilling(month=2026-05) ===');
  console.log('periodStart:', periodStart.toISOString());
  console.log('periodEnd:', periodEnd.toISOString());

  const convenioMatch = {
    $or: [
      { billingType: 'convenio' },
      { paymentMethod: 'convenio' },
      { packageType: 'convenio' },
      { paymentOrigin: 'convenio' },
      { insuranceProvider: { $exists: true, $ne: null } },
      { package: { $exists: true, $ne: null }, insuranceGuide: { $exists: true, $ne: null } }
    ]
  };

  const sessionMatch = {
    status: 'completed',
    $or: [
      { billingBatchId: { $exists: false } },
      { billingBatchId: null }
    ],
    date: { $gte: periodStart, $lte: periodEnd },
    $and: [convenioMatch]
  };

  const candidates = await Session.find(sessionMatch).select('_id date insuranceGuide').lean();
  console.log('candidateCount (antes do handledIds):', candidates.length);

  // handledIds
  const ALREADY_HANDLED_PAYMENT_STATUSES = ['billed', 'received', 'partial'];
  const paymentsForCandidates = await Payment.find({
    session: { $in: candidates.map(c => c._id) },
    $or: [
      { 'insurance.status': { $in: ALREADY_HANDLED_PAYMENT_STATUSES } },
      { status: { $in: ALREADY_HANDLED_PAYMENT_STATUSES } }
    ]
  }).select('session').lean();
  const handledIds = new Set(paymentsForCandidates.map(p => p.session?.toString()).filter(Boolean));
  console.log('handledIds size:', handledIds.size);

  if (handledIds.size > 0) {
    sessionMatch._id = { $nin: [...handledIds].map(id => new mongoose.Types.ObjectId(id)) };
  }

  const guidesWithPending = await Session.aggregate([
    { $match: sessionMatch },
    {
      $group: {
        _id: '$insuranceGuide',
        sessionsCount: { $sum: 1 },
        totalValue: { $sum: { $ifNull: ['$sessionValue', 0] } },
        minDate: { $min: '$date' },
        maxDate: { $max: '$date' }
      }
    },
    { $match: { _id: { $ne: null } } }
  ]);

  console.log('guias com pending no mês:', guidesWithPending.length);
  for (const g of guidesWithPending) {
    console.log(`  guia ${g._id.toString()}: ${g.sessionsCount} sessões, min=${g.minDate?.toISOString?.()}, max=${g.maxDate?.toISOString?.()}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
