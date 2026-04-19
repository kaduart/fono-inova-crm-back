// scripts/verificar-billingtype-backfill.js
// Verifica se os Payments criados pelo backfill têm billingType correto

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';

dotenv.config();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) {
    throw new Error('MONGO_URI não encontrado no .env');
}

await mongoose.connect(mongoUri);

// IDs dos 9 payments criados pelo backfill (do log do usuário)
const createdIds = [
    '69e4feeb3537a522feacaae9',
    '69e4feeb3537a522feacaaf7',
    '69e4feec3537a522feacab05',
    '69e4feec3537a522feacab13',
    '69e4feec3537a522feacab23',
    '69e4feed3537a522feacab34',
    '69e4feed3537a522feacab45',
    '69e4feee3537a522feacab56',
    '69e4feee3537a522feacab64'
];

console.log('[Verificação] Checando billingType dos Payments criados...\n');

for (const id of createdIds) {
    const p = await Payment.findById(id).lean();
    if (!p) {
        console.log(`[❌] Payment ${id}: NÃO ENCONTRADO`);
        continue;
    }
    const ok = p.billingType === 'convenio';
    console.log(
        `${ok ? '[✅]' : '[🔴 ERRO]'} Payment ${id}: billingType="${p.billingType}" | amount=${p.amount} | status=${p.status} | paymentMethod=${p.paymentMethod}`
    );
    if (!ok) {
        console.log(`      → insurance.status=${p.insurance?.status} | insurance.provider=${p.insurance?.provider}`);
    }
}

await mongoose.disconnect();
process.exit(0);
