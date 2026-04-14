import mongoose from 'mongoose';
import FinancialLedger from './models/FinancialLedger.js';
import Payment from './models/Payment.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // Pega um payment pago de abril
  const payment = await Payment.findOne({ status: 'paid', paymentDate: { $gte: new Date('2026-04-01') } });
  if (!payment) {
    console.log('Nenhum payment encontrado');
    process.exit(0);
  }
  
  console.log('Payment:', {
    id: payment._id.toString(),
    amount: payment.amount,
    patient: payment.patient?.toString(),
    appointment: payment.appointment?.toString(),
    correlationId: payment.correlationId,
    paidAt: payment.paidAt,
    paymentDate: payment.paymentDate,
    paymentMethod: payment.paymentMethod
  });
  
  try {
    const result = await FinancialLedger.credit({
      type: 'payment_received',
      amount: payment.amount,
      patient: payment.patient,
      appointment: payment.appointment,
      payment: payment._id,
      correlationId: payment.correlationId || `test_${Date.now()}`,
      description: 'Teste manual',
      occurredAt: payment.paidAt || payment.paymentDate || new Date(),
      metadata: { source: 'manual_test' }
    });
    console.log('LEDGER CRIADO:', result._id.toString());
  } catch (err) {
    console.error('ERRO AO CRIAR LEDGER:', err.message);
    console.error('Código:', err.code);
    if (err.errors) {
      console.error('Validation errors:', Object.keys(err.errors));
    }
  }
  
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
