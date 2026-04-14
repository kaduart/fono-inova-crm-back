import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import FinancialLedger from '../models/FinancialLedger.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const start = new Date('2026-04-01');
  const end = new Date('2026-04-30');
  
  const payments = await Payment.find({
    status: 'paid',
    paymentDate: { $gte: start, $lte: end }
  }).lean();
  
  let missing = 0;
  let missingAmount = 0;
  
  for (const p of payments) {
    const hasLedger = await FinancialLedger.exists({
      payment: p._id,
      type: { $in: ['payment_received', 'package_purchase'] }
    });
    if (!hasLedger) {
      missing++;
      missingAmount += p.amount;
      console.log(`Missing: ${p._id} - ${p.kind} - R$ ${p.amount}`);
    }
  }
  
  console.log(`\nMissing: ${missing} payments, R$ ${missingAmount}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
