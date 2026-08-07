import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id fullName').lean();
  const guides = await InsuranceGuide.find({ patientId: patient._id, number: { $in: ['2027', '2028', '2029'] } }).select('_id number specialty totalSessions usedSessions').lean();
  const guideMap = {};
  for (const g of guides) guideMap[g._id.toString()] = g;

  const sessions = await Session.find({
    patient: patient._id,
    insuranceGuide: { $in: guides.map(g => g._id) },
    status: 'completed'
  })
    .populate('appointmentId', 'time')
    .populate('doctor', 'fullName')
    .sort({ date: 1, 'appointmentId.time': 1 })
    .lean();

  console.log('Paciente:', patient.fullName, patient._id.toString());
  console.log('Guias:', guides.map(g => ({ number: g.number, specialty: g.specialty, total: g.totalSessions, used: g.usedSessions })));
  console.log('\nTodas as sessoes completadas das guias 2027/2028/2029:');
  for (const s of sessions) {
    const g = guideMap[s.insuranceGuide?.toString()];
    const payments = await Payment.find({ session: s._id }).lean();
    const p = payments.find(p => p.status !== 'canceled') || payments[0];
    const date = s.date.toISOString().slice(0, 10);
    const time = s.appointmentId?.time || '-';
    const doctor = s.doctor?.fullName || '-';
    const specialty = s.specialty || s.sessionType || '-';
    const status = p?.insurance?.status || p?.status || '-';
    console.log(`  ${date} ${time} | ${doctor.padEnd(25)} | ${specialty.padEnd(20)} | guia ${g?.number || '?'} (${g?.specialty}) | val ${s.sessionValue} | pmt ${status} | ${s._id}`);
  }
  console.log('Total:', sessions.length);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
