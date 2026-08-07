import mongoose from 'mongoose';
import dotenv from 'dotenv';
import insuranceBilling from '../services/billing/insuranceBilling.js';

dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const mongoSession = await mongoose.startSession();
  mongoSession.startTransaction();

  try {
    const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).session(mongoSession).lean();
    const guide2027 = await InsuranceGuide.findOne({ number: '2027', patientId: patient._id }).session(mongoSession).lean();
    const guide2028 = await InsuranceGuide.findOne({ number: '2028', patientId: patient._id }).session(mongoSession).lean();
    const guide2029 = await InsuranceGuide.findOne({ number: '2029', patientId: patient._id }).session(mongoSession).lean();

    console.log('Paciente:', patient._id.toString());
    console.log('Guias:', { 2027: guide2027._id.toString(), 2028: guide2028._id.toString(), 2029: guide2029._id.toString() });

    // 1. Cancelar a sessão duplicada de 23/02 14:00 Thayna na guia 2027
    const duplicata = await Session.findOne({
      _id: new mongoose.Types.ObjectId('69986c7d7c92d32c1fd44bef')
    }).session(mongoSession);

    if (duplicata) {
      console.log('\n1. Cancelando duplicata:', duplicata._id.toString());
      duplicata.status = 'canceled';
      await duplicata.save({ session: mongoSession });

      const apptDuplicata = await Appointment.findById(duplicata.appointmentId).session(mongoSession);
      if (apptDuplicata) {
        apptDuplicata.status = 'canceled';
        apptDuplicata.canceledAt = new Date();
        apptDuplicata.cancelReason = 'Sessão duplicada: atendimento de Thayna pertence à guia 2028 (TO)';
        await apptDuplicata.save({ session: mongoSession });
      }

      await Payment.updateMany(
        { session: duplicata._id },
        { $set: { status: 'canceled', 'insurance.status': 'canceled' } },
        { session: mongoSession }
      );
    }

    // 2. Corrigir especialidade da sessão 23/02 14:40 Lorrany na guia 2027
    const lorrany14 = await Session.findOne({
      _id: new mongoose.Types.ObjectId('699c6a74353c11d3c7775dbc')
    }).session(mongoSession);

    if (lorrany14) {
      console.log('\n2. Corrigindo sessão Lorrany 14:40 para fonoaudiologia');
      lorrany14.specialty = 'fonoaudiologia';
      lorrany14.sessionType = 'fonoaudiologia';
      await lorrany14.save({ session: mongoSession });

      const apptLorrany = await Appointment.findById(lorrany14.appointmentId).session(mongoSession);
      if (apptLorrany) {
        apptLorrany.specialty = 'fonoaudiologia';
        await apptLorrany.save({ session: mongoSession });
      }
    }

    // 3. Corrigir especialidade de todas as sessões da guia 2028 para terapia_ocupacional
    const guia2028Sessions = await Session.find({
      patient: patient._id,
      insuranceGuide: guide2028._id,
      status: 'completed'
    }).session(mongoSession).lean();

    console.log(`\n3. Corrigindo ${guia2028Sessions.length} sessões da guia 2028 para terapia_ocupacional`);
    for (const s of guia2028Sessions) {
      await Session.updateOne(
        { _id: s._id },
        { $set: { specialty: 'terapia_ocupacional', sessionType: 'terapia_ocupacional' } },
        { session: mongoSession }
      );

      if (s.appointmentId) {
        await Appointment.updateOne(
          { _id: s.appointmentId },
          { $set: { specialty: 'terapia_ocupacional' } },
          { session: mongoSession }
        );
      }
    }

    // 4. Corrigir especialidade das sessões da guia 2027 para fonoaudiologia
    const guia2027Sessions = await Session.find({
      patient: patient._id,
      insuranceGuide: guide2027._id,
      status: 'completed'
    }).session(mongoSession).lean();

    console.log(`\n4. Corrigindo ${guia2027Sessions.length} sessões da guia 2027 para fonoaudiologia`);
    for (const s of guia2027Sessions) {
      await Session.updateOne(
        { _id: s._id },
        { $set: { specialty: 'fonoaudiologia', sessionType: 'fonoaudiologia' } },
        { session: mongoSession }
      );

      if (s.appointmentId) {
        await Appointment.updateOne(
          { _id: s.appointmentId },
          { $set: { specialty: 'fonoaudiologia' } },
          { session: mongoSession }
        );
      }
    }

    // 5. Corrigir especialidade das sessões da guia 2029 para psicologia
    const guia2029Sessions = await Session.find({
      patient: patient._id,
      insuranceGuide: guide2029._id,
      status: 'completed'
    }).session(mongoSession).lean();

    console.log(`\n5. Corrigindo ${guia2029Sessions.length} sessões da guia 2029 para psicologia`);
    for (const s of guia2029Sessions) {
      await Session.updateOne(
        { _id: s._id },
        { $set: { specialty: 'psicologia', sessionType: 'psicologia' } },
        { session: mongoSession }
      );

      if (s.appointmentId) {
        await Appointment.updateOne(
          { _id: s.appointmentId },
          { $set: { specialty: 'psicologia' } },
          { session: mongoSession }
        );
      }
    }

    // 6. Corrigir sessionValue e payment.amount para 80 nas sessões das 3 guias
    const withZeroValue = await Session.find({
      patient: patient._id,
      insuranceGuide: { $in: [guide2027._id, guide2028._id, guide2029._id] },
      status: 'completed',
      $or: [
        { sessionValue: 0 },
        { sessionValue: { $exists: false } },
        { sessionValue: null }
      ]
    }).session(mongoSession).lean();

    console.log(`\n6. Corrigindo ${withZeroValue.length} sessões com sessionValue 0/inexistente para 80`);
    for (const s of withZeroValue) {
      await Session.updateOne(
        { _id: s._id },
        { $set: { sessionValue: 80 } },
        { session: mongoSession }
      );
    }

    // Também garante payment.amount=80 quando o payment ativo estiver zerado
    const paymentsToFix = await Payment.find({
      session: { $in: withZeroValue.map(s => s._id) },
      status: { $nin: ['canceled', 'cancelled'] },
      $or: [{ amount: 0 }, { amount: { $exists: false } }, { amount: null }]
    }).session(mongoSession).lean();

    console.log(`   Corrigindo ${paymentsToFix.length} payments zerados para amount=80`);
    for (const p of paymentsToFix) {
      await Payment.updateOne(
        { _id: p._id },
        { $set: { amount: 80, 'insurance.grossAmount': 80 } },
        { session: mongoSession }
      );
    }

    await mongoSession.commitTransaction();
    console.log('\n✅ Correções de especialidade/valor aplicadas com sucesso');

    // 7. Faturar sessões pendentes via serviço oficial (fora da transaction)
    const pendingSessions = await Session.find({
      patient: patient._id,
      insuranceGuide: { $in: [guide2027._id, guide2028._id, guide2029._id] },
      status: 'completed',
      $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }]
    }).lean();

    console.log(`\n7. Faturando ${pendingSessions.length} sessões pendentes`);
    for (const s of pendingSessions) {
      try {
        const result = await insuranceBilling.markSessionAsBilled(s._id.toString(), { billedAmount: 80 });
        console.log(`  ✅ ${s._id}: ${result.message}`);
      } catch (err) {
        console.log(`  ⚠️ ${s._id}: ${err.message}`);
      }
    }

    // 8. Resumo final
    console.log('\n=== RESUMO ===');
    const allSessions = await Session.find({
      patient: patient._id,
      status: 'completed',
      insuranceGuide: { $in: [guide2027._id, guide2028._id, guide2029._id] }
    })
      .populate('insuranceGuide', 'number specialty')
      .populate('appointmentId', 'time specialty')
      .populate('doctor', 'fullName')
      .sort({ date: 1, 'appointmentId.time': 1 })
      .lean();

    const byGuide = {};
    for (const s of allSessions) {
      const g = s.insuranceGuide;
      if (!byGuide[g.number]) byGuide[g.number] = { specialty: g.specialty, sessions: 0, value: 0 };
      byGuide[g.number].sessions += 1;
      byGuide[g.number].value += s.sessionValue || 80;
    }

    let totalSess = 0;
    let totalVal = 0;
    for (const [num, data] of Object.entries(byGuide).sort()) {
      console.log(`Guia ${num} (${data.specialty}): ${data.sessions} sess | R$ ${data.value.toFixed(2)}`);
      totalSess += data.sessions;
      totalVal += data.value;
    }
    console.log(`TOTAL: ${totalSess} sess | R$ ${totalVal.toFixed(2)}`);

  } catch (err) {
    await mongoSession.abortTransaction();
    console.error('Erro:', err);
    throw err;
  } finally {
    mongoSession.endSession();
    await mongoose.disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
