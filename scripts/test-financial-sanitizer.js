#!/usr/bin/env node
/**
 * 🧪 Teste do Financial Sanitizer
 * Verifica se o plugin bloqueia writes V1 na origem
 */

import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

async function run() {
  console.log('🧪 Testando Financial Sanitizer...\n');
  await mongoose.connect(MONGO_URI);

  // Test 1: Session.create com isPaid/paymentStatus
  console.log('Test 1: Session.create com isPaid=true, paymentStatus="paid"');
  try {
    const session = await Session.create({
      date: new Date(),
      time: '10:00',
      patient: new mongoose.Types.ObjectId(),
      doctor: new mongoose.Types.ObjectId(),
      sessionType: 'fonoaudiologia',
      isPaid: true,
      paymentStatus: 'paid'
    });
    console.log('  ✅ Criado:', session._id);
    console.log('  isPaid após sanitizer:', session.isPaid);
    console.log('  paymentStatus após sanitizer:', session.paymentStatus);
    console.log(session.isPaid === undefined && session.paymentStatus === undefined
      ? '  🟢 SANITIZER FUNCIONOU — campos removidos'
      : '  🔴 SANITIZER FALHOU — campos ainda existem'
    );
    // Limpar
    await Session.deleteOne({ _id: session._id });
  } catch (err) {
    console.log('  ❌ Erro:', err.message);
  }

  // Test 2: Appointment.insertMany com isPaid/paymentStatus
  console.log('\nTest 2: Appointment.insertMany com isPaid=true, paymentStatus="paid"');
  try {
    const appts = await Appointment.insertMany([{
      date: new Date(),
      time: '10:00',
      patient: new mongoose.Types.ObjectId(),
      doctor: new mongoose.Types.ObjectId(),
      specialty: 'fonoaudiologia',
      isPaid: true,
      paymentStatus: 'paid'
    }]);
    const appt = appts[0];
    console.log('  ✅ Criado:', appt._id);
    console.log('  isPaid após sanitizer:', appt.isPaid);
    console.log('  paymentStatus após sanitizer:', appt.paymentStatus);
    console.log(appt.isPaid === undefined && appt.paymentStatus === undefined
      ? '  🟢 SANITIZER FUNCIONOU — campos removidos'
      : '  🔴 SANITIZER FALHOU — campos ainda existem'
    );
    await Appointment.deleteOne({ _id: appt._id });
  } catch (err) {
    console.log('  ❌ Erro:', err.message);
  }

  // Test 3: Session.updateOne tentando setar isPaid
  console.log('\nTest 3: Session.updateOne tentando setar isPaid=true');
  try {
    const existing = await Session.create({
      date: new Date(),
      time: '11:00',
      patient: new mongoose.Types.ObjectId(),
      doctor: new mongoose.Types.ObjectId(),
      sessionType: 'fonoaudiologia'
    });
    await Session.updateOne(
      { _id: existing._id },
      { $set: { isPaid: true, paymentStatus: 'paid' } }
    );
    const updated = await Session.findById(existing._id);
    console.log('  isPaid após update:', updated.isPaid);
    console.log('  paymentStatus após update:', updated.paymentStatus);
    console.log(updated.isPaid === undefined && updated.paymentStatus === undefined
      ? '  🟢 SANITIZER FUNCIONOU — update bloqueado'
      : '  🔴 SANITIZER FALHOU — update passou'
    );
    await Session.deleteOne({ _id: existing._id });
  } catch (err) {
    console.log('  ❌ Erro:', err.message);
  }

  await mongoose.disconnect();
  console.log('\n✅ Testes concluídos.');
}

run().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
