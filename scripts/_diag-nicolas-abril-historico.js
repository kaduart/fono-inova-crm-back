import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const controller = await import('../controllers/insuranceV2Controller.js');

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id fullName').lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    await mongoose.disconnect();
    return;
  }
  console.log('Paciente:', patient.fullName, patient._id.toString());

  const startApr = new Date('2026-04-01T00:00:00-03:00');
  const endApr = new Date('2026-04-30T23:59:59-03:00');

  const sessions = await Session.find({
    patient: patient._id,
    status: 'completed',
    date: { $gte: startApr, $lte: endApr }
  })
    .populate('insuranceGuide', 'number insurance specialty billingMode')
    .populate('appointmentId', 'time')
    .populate('doctor', 'fullName specialty')
    .sort({ date: 1 })
    .lean();

  console.log(`\n=== Sessões de abril/2026 === ${sessions.length}`);
  for (const s of sessions) {
    const payments = await Payment.find({ session: s._id }).select('status insurance.status amount insurance.grossAmount').lean();
    console.log(`${s.date.toISOString()} ${s.appointmentId?.time} | ${s.specialty || s.sessionType} | doctor:${s.doctor?.fullName} | guia:${s.insuranceGuide?.number} | billingBatchId:${s.billingBatchId} | sessionValue:${s.sessionValue} | payments:${payments.map(p => `${p.status}/${p.insurance?.status}`).join(', ')}`);
  }

  // Histórico de 2026
  function fakeRes() {
    const res = {};
    res.status = (code) => { res._status = code; return res; };
    res.json = (body) => { res._body = body; return res; };
    return res;
  }

  const req = { query: { year: '2026' } };
  const res = fakeRes();
  await controller.getInsuranceHistory(req, res);
  const history = res._body;

  console.log('\n=== Histórico 2026 ===');
  for (const m of history.data) {
    const unimed = m.providers.find(p => p.provider === 'unimed-anapolis');
    if (unimed) {
      const pat = unimed.patients.find(p => p.name === patient.fullName);
      if (pat) {
        console.log(`${m.monthKey}: ${pat.totalSessions} sess | R$ ${pat.totalValue} | status:${unimed.status}`);
        for (const sp of pat.specialties) {
          console.log(`  ${sp.specialty}: ${sp.sessions} sess | R$ ${sp.value}`);
        }
      }
    }
  }

  // Drawer de abril
  const reqApr = { query: { patientId: patient._id.toString(), month: '2026-04', provider: 'unimed-anapolis', status: 'all' } };
  const resApr = fakeRes();
  await controller.getPatientInsuranceSessions(reqApr, resApr);
  const detail = resApr._body;
  console.log(`\n=== Drawer abril/2026 === count:${detail.count} billingModel:${detail.billingModel}`);
  for (const s of detail.data || []) {
    console.log(`${new Date(s.date).toISOString()} | ${s.specialty} | guia:${s.guideNumber} | ${s.billingStatus} | R$ ${s.grossAmount}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
