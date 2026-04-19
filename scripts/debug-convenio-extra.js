import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

dotenv.config();
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(mongoUri);

const start = new Date('2026-03-01T00:00:00-03:00');
const end = new Date('2026-03-31T23:59:59-03:00');

const payments = await Payment.find({
    status: 'pending',
    billingType: 'convenio',
    paymentDate: { $gte: start, $lte: end }
}).select('_id amount paymentDate serviceDate session sessionId').sort({ paymentDate: 1 }).lean();

console.log(`Total convênio pending com paymentDate em março: ${payments.length}\n`);

let total = 0;
for (const p of payments) {
    const session = p.session ? await Session.findById(p.session).select('date sessionValue').lean() : null;
    const dataSessao = session ? new Date(session.date).toISOString().split('T')[0] : 'SEM SESSION';
    const valorSessao = session?.sessionValue || 0;
    const dataPayment = p.paymentDate ? new Date(p.paymentDate).toISOString().split('T')[0] : 'N/A';
    
    const ehExtra = dataSessao !== 'SEM SESSION' && dataSessao.substring(0, 7) !== '2026-03';
    const marker = ehExtra ? '⚠️ EXTRA' : (dataSessao === 'SEM SESSION' ? '⚠️ ORFÃO' : '✅');
    
    console.log(`${marker} Payment ${p._id} | PaymentDate: ${dataPayment} | SessãoDate: ${dataSessao} | Payment$: ${p.amount} | Session$: ${valorSessao}`);
    total += p.amount;
}

console.log(`\nTOTAL: R$ ${total}`);

await mongoose.disconnect();
process.exit(0);
