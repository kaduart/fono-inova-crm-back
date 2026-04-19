import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';

dotenv.config();
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(mongoUri);

const start = new Date('2026-03-01T00:00:00-03:00');
const end = new Date('2026-03-31T23:59:59-03:00');

const convenios = await Payment.find({
    status: 'pending',
    billingType: 'convenio',
    paymentDate: { $gte: start, $lte: end }
}).select('_id amount insurance.provider session appointment').lean();

console.log(`Total convênio pending março: ${convenios.length}\n`);

const porValor = {};
const porProvider = {};
let total = 0;

for (const c of convenios) {
    const valor = c.amount;
    const provider = c.insurance?.provider || 'Não informado';
    
    porValor[valor] = (porValor[valor] || 0) + 1;
    porProvider[provider] = (porProvider[provider] || 0) + 1;
    total += valor;
    
    console.log(`${c._id} | R$ ${valor} | ${provider}`);
}

console.log('\n========================================');
console.log('Por valor:');
for (const [v, qtd] of Object.entries(porValor).sort((a,b) => a[0]-b[0])) {
    console.log(`  R$ ${v}: ${qtd} payments`);
}
console.log('\nPor convênio:');
for (const [p, qtd] of Object.entries(porProvider)) {
    console.log(`  ${p}: ${qtd} payments`);
}
console.log(`\nTOTAL: R$ ${total}`);
console.log('========================================');

await mongoose.disconnect();
process.exit(0);
