import mongoose from 'mongoose';
import Payment from './models/Payment.js';
import FinancialLedger from './models/FinancialLedger.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const start = new Date('2026-04-01');
  const end = new Date('2026-04-30');
  
  const totalPaid = await Payment.countDocuments({ status: 'paid', paymentDate: { $gte: start, $lte: end } });
  const totalAmount = await Payment.aggregate([
    { $match: { status: 'paid', paymentDate: { $gte: start, $lte: end } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  
  console.log(`Payments pagos: ${totalPaid}, Total: R$ ${totalAmount[0]?.total || 0}`);
  
  const sources = await Payment.aggregate([
    { $match: { status: 'paid', paymentDate: { $gte: start, $lte: end } } },
    { $group: { _id: { source: '$source', kind: '$kind' }, count: { $sum: 1 }, total: { $sum: '$amount' } } },
    { $sort: { count: -1 } }
  ]);
  
  console.log('Sources:', JSON.stringify(sources, null, 2));
  
  // Verifica ledger
  const ledgerCount = await FinancialLedger.countDocuments({ type: 'payment_received', occurredAt: { $gte: start, $lte: end } });
  console.log(`Ledger entries: ${ledgerCount}`);
  
  // Amostra de payments sem ledger
  const samplePayments = await Payment.find({ status: 'paid', paymentDate: { $gte: start, $lte: end } }).limit(5).lean();
  for (const p of samplePayments) {
    const hasLedger = await FinancialLedger.exists({ payment: p._id, type: 'payment_received' });
    console.log(`Payment ${p._id}: source=${p.source}, kind=${p.kind}, hasLedger=${!!hasLedger}`);
  }
  
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
