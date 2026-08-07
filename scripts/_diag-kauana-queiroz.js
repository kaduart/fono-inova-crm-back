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

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id fullName').lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    await mongoose.disconnect();
    return;
  }
  console.log('Paciente:', patient.fullName, patient._id.toString());

  const allSessions = await Session.find({ patient: patient._id, status: 'completed' })
    .populate('insuranceGuide', 'number insurance billingMode totalSessions usedSessions')
    .populate('appointmentId', 'time')
    .populate('doctor', 'fullName specialty')
    .sort({ date: 1 })
    .lean();

  console.log(`\n=== Todas as sessões completadas === ${allSessions.length}`);
  for (const s of allSessions) {
    const payments = await Payment.find({ session: s._id }).select('status insurance.status amount insurance.grossAmount insurance.provider').lean();
    const guideNum = s.insuranceGuide?.number || 'sem-guia';
    console.log(`${s.date.toISOString()} | time:${s.appointmentId?.time} | ${s.specialty || s.sessionType || '-'} | doctor:${s.doctor?.fullName} | guia:${guideNum} | billingBatchId:${s.billingBatchId} | sessionValue:${s.sessionValue} | payments:${payments.map(p => `${p.status}/${p.insurance?.status || '-'}/${p.insurance?.provider || '-'}`).join(' ')}`);
  }

  // Guias do paciente
  const guides = await InsuranceGuide.find({ patientId: patient._id }).lean();
  console.log(`\n=== Guias do paciente === ${guides.length}`);
  for (const g of guides) {
    const guideSessions = allSessions.filter(s => s.insuranceGuide?._id?.toString() === g._id.toString());
    const batched = guideSessions.filter(s => s.billingBatchId);
    const pending = guideSessions.filter(s => !s.billingBatchId);
    console.log(`Guia ${g.number} (${g.insurance}) | total:${g.totalSessions} used:${g.usedSessions} | status:${g.status} | billingMode:${g.billingMode} | sessões:${guideSessions.length} faturadas:${batched.length} pendentes:${pending.length}`);
  }

  // Lotes com sessões do paciente
  const batchIds = [...new Set(allSessions.map(s => s.billingBatchId?.toString()).filter(Boolean))];
  if (batchIds.length > 0) {
    const batches = await InsuranceBatch.find({ _id: { $in: batchIds } }).lean();
    console.log(`\n=== Lotes vinculados === ${batches.length}`);
    for (const b of batches) {
      const patientSessions = b.sessions.filter(bs => {
        const sid = bs.session?.toString?.() || bs.session;
        return allSessions.some(s => s._id.toString() === sid);
      });
      console.log(`Lote ${b.batchNumber} (${b._id}) | status:${b.status} | sentDate:${b.sentDate?.toISOString?.()} | sessões do paciente:${patientSessions.length}`);
      for (const bs of patientSessions) {
        const s = allSessions.find(sess => sess._id.toString() === (bs.session?.toString?.() || bs.session));
        console.log(`  - ${s?.date?.toISOString?.()} | guia:${s?.insuranceGuide?.number || '-'} | gross:${bs.grossAmount} | status:${bs.status}`);
      }
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
