import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;

  const batchId = '6a06176828952ae1cb1fa7bc';
  const batch = await InsuranceBatch.findById(batchId).lean();
  if (!batch) {
    console.log('Lote não encontrado');
    await mongoose.disconnect();
    return;
  }

  console.log('Lote:', batch.batchNumber);
  console.log('status:', batch.status);
  console.log('sentDate:', batch.sentDate?.toISOString());
  console.log('insuranceProvider:', batch.insuranceProvider);
  console.log('totalSessions:', batch.totalSessions);
  console.log('totalGross:', batch.totalGross);

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id fullName').lean();

  // Todas as sessões do lote
  const sessionIds = batch.sessions.map(s => s.session?.toString()).filter(Boolean);
  const sessions = await Session.find({ _id: { $in: sessionIds } })
    .populate('appointmentId', 'time specialty')
    .populate('insuranceGuide', 'number specialty')
    .sort({ date: 1 })
    .lean();

  const sessionMap = new Map(sessions.map(s => [s._id.toString(), s]));

  console.log(`\n=== Todas as sessões do lote === ${batch.sessions.length}`);
  for (const bs of batch.sessions) {
    const sid = bs.session?.toString();
    const s = sessionMap.get(sid);
    if (!s) continue;
    const isPatient = s.patient?.toString() === patient._id.toString();
    console.log(`${s.date.toISOString()} | ${s.appointmentId?.specialty || s.specialty || s.sessionType} | guia:${s.insuranceGuide?.number}(${s.insuranceGuide?.specialty}) | patient:${isPatient ? 'Nicolas' : 'OUTRO'} | gross:${bs.grossAmount}`);
  }

  // Sessões de abril do Nicolas no lote
  console.log('\n=== Sessões de abril/2026 do Nicolas no lote ===');
  const abrilNicolas = batch.sessions.filter(bs => {
    const sid = bs.session?.toString();
    const s = sessionMap.get(sid);
    if (!s) return false;
    const d = new Date(s.date);
    return d.getFullYear() === 2026 && d.getMonth() === 3 && s.patient?.toString() === patient._id.toString();
  });
  for (const bs of abrilNicolas) {
    const s = sessionMap.get(bs.session.toString());
    console.log(`${s.date.toISOString()} | ${s.appointmentId?.specialty || s.specialty || s.sessionType} | guia:${s.insuranceGuide?.number}(${s.insuranceGuide?.specialty}) | gross:${bs.grossAmount}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
