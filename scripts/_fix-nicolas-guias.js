import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id').lean();

  // Corrige guias 15650231 e 15655250 para fonoaudiologia
  const guides = await InsuranceGuide.find({
    patientId: patient._id,
    number: { $in: ['15650231', '15655250'] }
  }).lean();

  console.log(`Corrigindo ${guides.length} guias para fonoaudiologia`);
  for (const g of guides) {
    await InsuranceGuide.updateOne(
      { _id: g._id },
      { $set: { specialty: 'fonoaudiologia' } }
    );
    console.log(`  Guia ${g.number} -> fonoaudiologia`);
  }

  // Corrige sessoes dessas guias que estao como terapia_ocupacional para fonoaudiologia
  const guideIds = guides.map(g => g._id);
  const sessions = await Session.find({
    patient: patient._id,
    insuranceGuide: { $in: guideIds },
    status: 'completed',
    $or: [
      { specialty: 'terapia_ocupacional' },
      { sessionType: 'terapia_ocupacional' }
    ]
  }).lean();

  console.log(`\nCorrigindo ${sessions.length} sessoes para fonoaudiologia`);
  for (const s of sessions) {
    await Session.updateOne(
      { _id: s._id },
      { $set: { specialty: 'fonoaudiologia', sessionType: 'fonoaudiologia' } }
    );
    if (s.appointmentId) {
      await Appointment.updateOne(
        { _id: s.appointmentId },
        { $set: { specialty: 'fonoaudiologia' } }
      );
    }
    console.log(`  ${s._id} ${s.date.toISOString().slice(0,10)} -> fonoaudiologia`);
  }

  // Corrige appointments vinculados as guias para fonoaudiologia
  // O getInsuranceHistory usa appt.specialty para sessoes faturadas em lote.
  const apptIds = await Session.distinct('appointmentId', {
    patient: patient._id,
    insuranceGuide: { $in: guideIds }
  });

  const appointments = await Appointment.find({
    _id: { $in: apptIds },
    specialty: 'terapia_ocupacional'
  }).select('_id specialty').lean();

  console.log(`\nCorrigindo ${appointments.length} appointments para fonoaudiologia`);
  for (const a of appointments) {
    await Appointment.updateOne(
      { _id: a._id },
      { $set: { specialty: 'fonoaudiologia' } }
    );
    console.log(`  ${a._id} appointment -> fonoaudiologia`);
  }

  // Remove referencia legada 'package' das sessoes que ja tem guia
  // O controller ainda prioriza package.specialty sobre session/guia no drawer,
  // entao essa referencia legada mascara a especialidade real.
  const sessionsWithPackage = await Session.find({
    patient: patient._id,
    insuranceGuide: { $in: guideIds },
    package: { $exists: true, $ne: null }
  }).select('_id package').lean();

  console.log(`\nRemovendo package legado de ${sessionsWithPackage.length} sessoes`);
  for (const s of sessionsWithPackage) {
    await Session.updateOne({ _id: s._id }, { $unset: { package: 1 } });
    console.log(`  ${s._id} package removido`);
  }

  // Resumo
  console.log('\n=== RESUMO ===');
  const updatedGuides = await InsuranceGuide.find({ patientId: patient._id, number: { $in: ['15650231', '15655250'] } }).lean();
  for (const g of updatedGuides) {
    const count = await Session.countDocuments({ patient: patient._id, insuranceGuide: g._id, status: 'completed' });
    console.log(`Guia ${g.number} (${g.specialty}): ${count} sessoes`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
