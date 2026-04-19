import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';

dotenv.config();
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(mongoUri);

// Buscar TODOS os pending de março de várias formas
console.log('=== PENDING DE MARÇO — Múltiplas estratégias ===\n');

// 1. Por paymentDate
const byPaymentDate = await Payment.find({
    status: 'pending',
    paymentDate: { $gte: '2026-03-01', $lte: '2026-03-31' }
}).select('_id amount paymentDate serviceDate billingType status session appointment').lean();

console.log(`1. Por paymentDate: ${byPaymentDate.length} results`);
byPaymentDate.forEach(p => console.log(`   ${p._id} | R$ ${p.amount} | paymentDate=${p.paymentDate} | billingType=${p.billingType}`));

// 2. Por serviceDate
const byServiceDate = await Payment.find({
    status: 'pending',
    serviceDate: { $gte: '2026-03-01', $lte: '2026-03-31' }
}).select('_id amount paymentDate serviceDate billingType status').lean();

console.log(`\n2. Por serviceDate: ${byServiceDate.length} results`);
byServiceDate.forEach(p => console.log(`   ${p._id} | R$ ${p.amount} | serviceDate=${p.serviceDate} | billingType=${p.billingType}`));

// 3. Por createdAt (ISODate)
const start = new Date('2026-03-01T00:00:00-03:00');
const end = new Date('2026-03-31T23:59:59-03:00');
const byCreatedAt = await Payment.find({
    status: 'pending',
    createdAt: { $gte: start, $lte: end }
}).select('_id amount paymentDate serviceDate billingType status createdAt').lean();

console.log(`\n3. Por createdAt: ${byCreatedAt.length} results`);
byCreatedAt.forEach(p => console.log(`   ${p._id} | R$ ${p.amount} | createdAt=${p.createdAt?.toISOString()?.split('T')[0]} | paymentDate=${p.paymentDate} | billingType=${p.billingType}`));

// 4. Todos os particular pending — mostrar datas
const allParticular = await Payment.find({
    status: 'pending',
    billingType: 'particular'
}).select('_id amount paymentDate serviceDate status').sort({ paymentDate: -1 }).limit(20).lean();

console.log(`\n4. Top 20 particular pending (ordem paymentDate decrescente):`);
allParticular.forEach(p => console.log(`   ${p._id} | R$ ${p.amount} | paymentDate=${p.paymentDate} | serviceDate=${p.serviceDate}`));

await mongoose.disconnect();
