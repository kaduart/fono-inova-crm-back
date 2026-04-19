import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';

dotenv.config();
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(mongoUri);

const start = new Date('2026-03-01T00:00:00-03:00');
const end = new Date('2026-03-31T23:59:59-03:00');

console.log('=== VALIDAÇÃO FINAL — MARÇO/2026 ===\n');

// Particular
const particular = await Payment.aggregate([
  { $match: { status: 'pending', billingType: 'particular', paymentDate: { $gte: start, $lte: end } } },
  { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
]);

// Convenio
const convenio = await Payment.aggregate([
  { $match: { status: 'pending', billingType: 'convenio', paymentDate: { $gte: start, $lte: end } } },
  { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
]);

console.log(`Particular pending:  R$ ${particular[0]?.total || 0} (${particular[0]?.count || 0} payments)`);
console.log(`Convênio pending:    R$ ${convenio[0]?.total || 0} (${convenio[0]?.count || 0} payments)`);
console.log(`TOTAL PENDENTE:      R$ ${(particular[0]?.total || 0) + (convenio[0]?.total || 0)}`);

await mongoose.disconnect();
process.exit(0);
