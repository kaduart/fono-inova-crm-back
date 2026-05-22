import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function main() {
  await mongoose.connect(MONGO_URI);
  const patientId = '685b0cfaaec14c7163585b5b';
  const patientOid = new mongoose.Types.ObjectId(patientId);

  console.log('══════════════════════════════════════════════════════════');
  console.log('  CORREÇÃO PAYMENTS — ISIS CALDAS');
  console.log('══════════════════════════════════════════════════════════\n');

  // ─────────────────────────────────────────────────────────
  // 1. CRIAR PAYMENTS PARA 27/04
  // ─────────────────────────────────────────────────────────
  const appts27 = await Appointment.find({
    patient: patientOid,
    date: {
      $gte: new Date('2026-04-27T00:00:00-03:00'),
      $lte: new Date('2026-04-27T23:59:59-03:00')
    }
  }).lean();

  console.log('1️⃣  Appointments de 27/04 encontrados:', appts27.length);
  for (const appt of appts27) {
    const existing = await Payment.findOne({ appointment: appt._id }).lean();
    if (existing) {
      console.log('   ✅ Já existe payment:', existing._id.toString(), existing.status);
      continue;
    }

    // Cria payment PAID (as sessões de abril foram pagas pela quitação de 28/04)
    const payment = await Payment.create({
      patient: patientOid,
      amount: appt.sessionValue || 0,
      status: 'paid',
      kind: 'session_payment',
      billingType: 'particular',
      paymentMethod: 'dinheiro',
      paymentDate: new Date('2026-04-27T12:00:00-03:00'),
      paidAt: new Date('2026-04-27T12:00:00-03:00'),
      financialDate: new Date('2026-04-27T12:00:00-03:00'),
      appointment: appt._id,
      description: `Sessão realizada - Isis Caldas Rebelatto`,
      createdAt: new Date('2026-04-27T12:00:00-03:00')
    });

    await Appointment.updateOne(
      { _id: appt._id },
      { $set: { payment: payment._id } }
    );

    console.log('   ✅ Criado payment PAID:', payment._id.toString(), '| R$', payment.amount, '|', appt.specialty, appt.time);
  }

  // ─────────────────────────────────────────────────────────
  // 2. REMOVER PAYMENT PAID DUPLICADO DO DIA 08/05
  // ─────────────────────────────────────────────────────────
  const appts08 = await Appointment.find({
    patient: patientOid,
    date: {
      $gte: new Date('2026-05-08T00:00:00-03:00'),
      $lte: new Date('2026-05-08T23:59:59-03:00')
    }
  }).lean();

  console.log('\n2️⃣  Appointments de 08/05 encontrados:', appts08.length);
  for (const appt of appts08) {
    const payments = await Payment.find({ appointment: appt._id }).lean();
    if (payments.length <= 1) {
      console.log('   ✅ Apenas 1 payment, OK:', payments[0]?._id.toString(), payments[0]?.status);
      continue;
    }

    const paidOne = payments.find(p => p.status === 'paid');
    const pendingOne = payments.find(p => p.status === 'pending');

    if (paidOne) {
      await Payment.deleteOne({ _id: paidOne._id });
      console.log('   🗑️  Removido payment PAID duplicado:', paidOne._id.toString(), '| R$', paidOne.amount, '|', appt.specialty);
    }

    if (pendingOne) {
      await Appointment.updateOne(
        { _id: appt._id },
        { $set: { payment: pendingOne._id } }
      );
      console.log('   ✅ Mantido payment PENDING:', pendingOne._id.toString());
    }
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ✅ CORREÇÃO CONCLUÍDA');
  console.log('══════════════════════════════════════════════════════════');

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
