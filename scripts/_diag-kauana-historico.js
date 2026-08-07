import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Patient = (await import('../models/Patient.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const controller = await import('../controllers/insuranceV2Controller.js');

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id fullName').lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    await mongoose.disconnect();
    return;
  }
  console.log('Paciente:', patient.fullName, patient._id.toString());

  const guides = await InsuranceGuide.find({ patientId: patient._id }).lean();
  console.log('\n=== Guias ===');
  for (const g of guides) {
    console.log(`Guia ${g.number}: issuedAt=${g.issuedAt?.toISOString?.() || 'null'} | createdAt=${g.createdAt?.toISOString?.()} | billingMode=${g.billingMode} | status=${g.status} | total=${g.totalSessions} | used=${g.usedSessions} | sessionValue=${g.sessionValue}`);
  }

  function fakeRes() {
    const res = {};
    res.status = (code) => { res._status = code; return res; };
    res.json = (body) => { res._body = body; return res; };
    return res;
  }

  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
  for (const month of months) {
    const req = { query: { patientId: patient._id.toString(), month, specialty: 'fonoaudiologia', provider: 'unimed-anapolis', status: 'all' } };
    const res = fakeRes();
    await controller.getPatientInsuranceSessions(req, res);
    const body = res._body;
    console.log(`\n=== ${month} === count=${body.count} billingModel=${body.billingModel}`);
    for (const g of body.groups || []) {
      console.log(`  ${g.type} ${g.guideNumber || g.batchId || 'n/a'}: ${g.sessions?.length} sessões | gross=${g.summary?.grossAmount} | status=${g.summary?.status}`);
    }
    for (const s of body.data || []) {
      console.log(`  - ${new Date(s.date).toISOString()} | ${s.specialty} | guia=${s.guideNumber || '-'} | ${s.billingStatus} | gross=${s.grossAmount} | batch=${s.batchNumber || '-'}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
