import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const Payment = (await import('../models/Payment.js')).default;

  const patients = await Patient.find({ fullName: /Lucca/i }).select('_id fullName').lean();
  console.log('Pacientes encontrados:', patients.map(p => `${p.fullName} (${p._id})`).join('\n'));

  for (const patient of patients) {
    console.log(`\n=== ${patient.fullName} ===`);
    const start = new Date('2026-03-01T00:00:00-03:00');
    const end = new Date('2026-05-31T23:59:59-03:00');

    const sessions = await Session.find({
      patient: patient._id,
      status: 'completed',
      date: { $gte: start, $lte: end }
    })
      .populate('insuranceGuide', 'number insurance specialty sessionValue totalSessions usedSessions issuedAt')
      .populate('doctor', 'fullName specialty')
      .sort({ date: 1 })
      .lean();

    console.log(`Sessões mar/abr/mai: ${sessions.length}`);
    for (const s of sessions) {
      const payments = await Payment.find({ session: s._id }).select('status insurance.status amount insurance.grossAmount').lean();
      const pstatus = payments.map(p => p.status || p.insurance?.status).join(', ');
      console.log(`${s.date.toISOString().slice(0,10)} | ${s.sessionType || s.specialty} | ${s.doctor?.fullName || ''} | ${s.insuranceGuide ? 'guia ' + s.insuranceGuide.number + ' (' + s.insuranceGuide.insurance + ')' : 'sem guia'} | paymentStatus: ${pstatus || 'nenhum'}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
