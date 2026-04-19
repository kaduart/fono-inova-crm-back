import moment from 'moment-timezone';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

dotenv.config();
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(mongoUri);

const start = new Date('2026-03-01T00:00:00-03:00');
const end = new Date('2026-03-31T23:59:59-03:00');

// Buscar TODAS as sessões de convênio completed em março
const sessions = await Session.find({
    status: 'completed',
    date: { $gte: start, $lte: end },
    $or: [
        { paymentMethod: 'convenio' },
        { insuranceGuide: { $exists: true, $ne: null } }
    ]
}).select('_id date sessionValue paymentMethod insuranceGuide insuranceProvider').lean();

console.log(`Total sessões convênio completed março: ${sessions.length}\n`);

let comPayment = 0;
let semPayment = 0;
let totalValor = 0;

for (const s of sessions) {
    const payment = await Payment.findOne({
        $or: [
            { session: s._id },
            { sessionId: s._id.toString() }
        ]
    }).select('_id amount billingType insurance.provider').lean();

    const valor = s.sessionValue || 0;
    totalValor += valor;

    if (payment) {
        comPayment++;
        console.log(`✅ ${s._id} | ${moment(s.date).format('DD/MM')} | R$ ${valor} | ${s.insuranceProvider || 'N/A'} | Payment: ${payment._id} | R$ ${payment.amount}`);
    } else {
        semPayment++;
        console.log(`❌ ${s._id} | ${moment(s.date).format('DD/MM')} | R$ ${valor} | ${s.insuranceProvider || 'N/A'} | SEM PAYMENT`);
    }
}

console.log('\n========================================');
console.log(`Total sessões: ${sessions.length}`);
console.log(`Com Payment: ${comPayment}`);
console.log(`Sem Payment: ${semPayment}`);
console.log(`Soma sessionValue: R$ ${totalValor}`);
console.log('========================================');

await mongoose.disconnect();
process.exit(0);
