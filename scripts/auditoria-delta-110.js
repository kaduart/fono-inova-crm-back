// scripts/auditoria-delta-110.js
// Auditoria cirúrgica para encontrar a origem dos R$ 110 de diferença
// no convênio de março/2026.

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const MARCO_START = moment.tz('2026-03-01', TIMEZONE).startOf('day').toDate();
const MARCO_END = moment.tz('2026-03-31', TIMEZONE).endOf('day').toDate();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(mongoUri);

console.log('=== AUDITORIA DELTA R$ 110 — CONVÊNIO MARÇO/2026 ===\n');

// 1. Valor esperado pelas Sessions (fonte de verdade clínica)
const sessions = await Session.find({
    status: 'completed',
    date: { $gte: MARCO_START, $lte: MARCO_END },
    $or: [
        { paymentMethod: 'convenio' },
        { insuranceGuide: { $exists: true, $ne: null } }
    ]
}).select('_id date sessionValue patient').lean();

const valorEsperado = sessions.reduce((sum, s) => sum + (s.sessionValue || 0), 0);
console.log(`1. Valor esperado (Sessions):        R$ ${valorEsperado} (${sessions.length} sessões)`);

// 2. Valor em Payments PENDING de março
const pendingPayments = await Payment.find({
    billingType: 'convenio',
    status: 'pending',
    paymentDate: { $gte: MARCO_START, $lte: MARCO_END }
}).select('_id amount session paymentDate insurance.status').lean();

const valorPending = pendingPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
console.log(`2. Valor em Payments PENDING:        R$ ${valorPending} (${pendingPayments.length} payments)`);

// 3. Valor em Payments BILLED de março
const billedPayments = await Payment.find({
    billingType: 'convenio',
    status: { $in: ['billed', 'partial'] },
    paymentDate: { $gte: MARCO_START, $lte: MARCO_END }
}).select('_id amount session paymentDate insurance.status').lean();

const valorBilled = billedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
console.log(`3. Valor em Payments BILLED:         R$ ${valorBilled} (${billedPayments.length} payments)`);

// 4. Valor em Payments PAID de março
const paidPayments = await Payment.find({
    billingType: 'convenio',
    status: { $in: ['paid', 'completed', 'confirmed'] },
    paymentDate: { $gte: MARCO_START, $lte: MARCO_END }
}).select('_id amount session paymentDate').lean();

const valorPaid = paidPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
console.log(`4. Valor em Payments PAID:           R$ ${valorPaid} (${paidPayments.length} payments)`);

// 5. Valor em Payments CANCELED de março
const canceledPayments = await Payment.find({
    billingType: 'convenio',
    status: 'canceled',
    paymentDate: { $gte: MARCO_START, $lte: MARCO_END }
}).select('_id amount session paymentDate').lean();

const valorCanceled = canceledPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
console.log(`5. Valor em Payments CANCELED:       R$ ${valorCanceled} (${canceledPayments.length} payments)`);

// 6. Soma total de todos os Payments de convênio com data em março
const totalPayments = valorPending + valorBilled + valorPaid + valorCanceled;
console.log(`\n6. SOMA TOTAL (todos os status):     R$ ${totalPayments}`);

// 7. Delta
const delta = valorEsperado - valorPending;
console.log(`\n🔍 DELTA: Esperado R$ ${valorEsperado} - Pending R$ ${valorPending} = R$ ${delta}`);

// 8. Cruzamento Session vs Payment
console.log('\n=== CRUZAMENTO SESSION vs PAYMENT ===');
const cruzamento = [];
for (const s of sessions.sort((a, b) => a.date - b.date)) {
    const p = await Payment.findOne({
        $or: [
            { session: s._id },
            { sessionId: s._id.toString() }
        ],
        billingType: 'convenio'
    }).select('_id amount status paymentDate').lean();

    const status = p ? p.status : 'SEM PAYMENT';
    const valorPayment = p ? p.amount : 0;
    const diff = (s.sessionValue || 0) - valorPayment;

    cruzamento.push({
        data: moment(s.date).tz(TIMEZONE).format('DD/MM'),
        sessionValue: s.sessionValue || 0,
        paymentAmount: valorPayment,
        status,
        diff
    });
}

console.table(cruzamento);

const sessoesSemPayment = cruzamento.filter(c => c.status === 'SEM PAYMENT');
const sessoesDiff = cruzamento.filter(c => c.diff !== 0 && c.status !== 'SEM PAYMENT');

console.log(`\nSessões SEM Payment: ${sessoesSemPayment.length}`);
console.log(`Sessões com valor diferente: ${sessoesDiff.length}`);
if (sessoesDiff.length > 0) {
    console.table(sessoesDiff);
}

await mongoose.disconnect();
process.exit(0);
