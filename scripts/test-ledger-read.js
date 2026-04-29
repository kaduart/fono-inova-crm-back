#!/usr/bin/env node
/**
 * 🧪 Teste do Ledger Read Service
 */

import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import { LedgerReadService } from '../services/financialGuard/ledgerReadService.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

async function run() {
  console.log('🧪 Testando Ledger Read Service...\n');
  await mongoose.connect(MONGO_URI);

  const patientId = new mongoose.Types.ObjectId();
  const doctorId = new mongoose.Types.ObjectId();

  // Criar session sem payment
  console.log('Test 1: Session SEM payment');
  const session1 = await Session.create({
    date: new Date(),
    time: '10:00',
    patient: patientId,
    doctor: doctorId,
    sessionType: 'fonoaudiologia'
  });
  const status1 = await LedgerReadService.deriveSessionStatus(session1._id);
  console.log('  isPaid:', status1.isPaid, '| paymentStatus:', status1.paymentStatus);
  console.log(status1.paymentStatus === 'unpaid' ? '  🟢 OK' : '  🔴 FALHA');
  await Session.deleteOne({ _id: session1._id });

  // Criar session com payment PAGO
  console.log('\nTest 2: Session COM payment PAGO');
  const session2 = await Session.create({
    date: new Date(),
    time: '11:00',
    patient: patientId,
    doctor: doctorId,
    sessionType: 'fonoaudiologia'
  });
  const payment2 = await Payment.create({
    patient: patientId,
    session: session2._id,
    amount: 180,
    status: 'paid',
    paidAt: new Date(),
    paymentMethod: 'pix',
    billingType: 'particular',
    kind: 'session_payment',
    paymentDate: new Date()
  });
  const status2 = await LedgerReadService.deriveSessionStatus(session2._id);
  console.log('  isPaid:', status2.isPaid, '| paymentStatus:', status2.paymentStatus, '| amount:', status2.paymentAmount);
  console.log(status2.isPaid === true && status2.paymentStatus === 'paid' ? '  🟢 OK' : '  🔴 FALHA');
  await Payment.deleteOne({ _id: payment2._id });
  await Session.deleteOne({ _id: session2._id });

  // Criar session com payment PENDING
  console.log('\nTest 3: Session COM payment PENDING');
  const session3 = await Session.create({
    date: new Date(),
    time: '12:00',
    patient: patientId,
    doctor: doctorId,
    sessionType: 'fonoaudiologia'
  });
  const payment3 = await Payment.create({
    patient: patientId,
    session: session3._id,
    amount: 180,
    status: 'pending',
    paymentMethod: 'pix',
    billingType: 'particular',
    kind: 'session_payment',
    paymentDate: new Date()
  });
  const status3 = await LedgerReadService.deriveSessionStatus(session3._id);
  console.log('  isPaid:', status3.isPaid, '| paymentStatus:', status3.paymentStatus);
  console.log(status3.isPaid === false && status3.paymentStatus === 'pending' ? '  🟢 OK' : '  🔴 FALHA');
  await Payment.deleteOne({ _id: payment3._id });
  await Session.deleteOne({ _id: session3._id });

  // Test 4: Batch
  console.log('\nTest 4: Batch de 3 sessions');
  const sessions = await Session.insertMany([
    { date: new Date(), time: '10:00', patient: patientId, doctor: doctorId, sessionType: 'fonoaudiologia' },
    { date: new Date(), time: '11:00', patient: patientId, doctor: doctorId, sessionType: 'fonoaudiologia' },
    { date: new Date(), time: '12:00', patient: patientId, doctor: doctorId, sessionType: 'fonoaudiologia' }
  ]);
  const payment4 = await Payment.create({
    patient: patientId,
    session: sessions[1]._id,
    amount: 180,
    status: 'paid',
    paidAt: new Date(),
    paymentMethod: 'pix',
    billingType: 'particular',
    kind: 'session_payment',
    paymentDate: new Date()
  });
  const batch = await LedgerReadService.deriveBatchSessionStatus(
    sessions.map(s => s._id)
  );
  console.log('  Session 1 (sem payment):', batch[sessions[0]._id].isPaid, batch[sessions[0]._id].paymentStatus);
  console.log('  Session 2 (com payment):', batch[sessions[1]._id].isPaid, batch[sessions[1]._id].paymentStatus);
  console.log('  Session 3 (sem payment):', batch[sessions[2]._id].isPaid, batch[sessions[2]._id].paymentStatus);
  const batchOk = !batch[sessions[0]._id].isPaid && batch[sessions[1]._id].isPaid && !batch[sessions[2]._id].isPaid;
  console.log(batchOk ? '  🟢 OK' : '  🔴 FALHA');

  await Payment.deleteOne({ _id: payment4._id });
  await Session.deleteMany({ _id: { $in: sessions.map(s => s._id) } });

  await mongoose.disconnect();
  console.log('\n✅ Testes concluídos.');
}

run().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
