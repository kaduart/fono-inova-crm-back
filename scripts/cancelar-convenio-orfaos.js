// scripts/cancelar-convenio-orfaos.js
// Cancela payments de convênio órfãos do V1 (sem session linkada)
// que foram duplicados pelo backfill.
//
// Uso: node scripts/cancelar-convenio-orfaos.js [dry-run]

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

dotenv.config();

const DRY_RUN = process.argv.includes('dry-run');

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');

await mongoose.connect(mongoUri);

const start = new Date('2026-03-01T00:00:00-03:00');
const end = new Date('2026-03-31T23:59:59-03:00');

// Buscar payments de convênio pending em março
const payments = await Payment.find({
    status: 'pending',
    billingType: 'convenio',
    paymentDate: { $gte: start, $lte: end }
}).select('_id amount session sessionId paymentDate').lean();

let cancelados = 0;
let mantidos = 0;
let totalCancelado = 0;

for (const p of payments) {
    // Verificar se tem session linkada
    let temSession = false;
    if (p.session) {
        const session = await Session.findById(p.session).select('_id').lean();
        if (session) temSession = true;
    }
    if (!temSession && p.sessionId) {
        const session = await Session.findById(p.sessionId).select('_id').lean();
        if (session) temSession = true;
    }

    if (temSession) {
        mantidos++;
        continue;
    }

    // Payment órfão - cancelar
    if (DRY_RUN) {
        console.log(`[DRY-RUN] Cancelaria Payment ${p._id} | R$ ${p.amount} | ${new Date(p.paymentDate).toISOString().split('T')[0]} | SEM SESSION`);
    } else {
        await Payment.findByIdAndUpdate(p._id, {
            $set: {
                status: 'canceled',
                notes: `[RECONCILIAÇÃO: cancelado pois é órfão do V1 sem session linkada. Payment duplicado pelo backfill V2.] ${p.notes || ''}`.trim(),
                updatedAt: new Date()
            }
        });
        console.log(`[CANCELADO] Payment ${p._id} | R$ ${p.amount} | SEM SESSION`);
    }
    cancelados++;
    totalCancelado += p.amount;
}

console.log('\n========================================');
console.log('[Cancelar Convenio Orfãos] RESUMO');
console.log('========================================');
console.log(`Total analisado:   ${payments.length}`);
console.log(`Mantidos:          ${mantidos}`);
console.log(`Cancelados:        ${cancelados}`);
console.log(`Valor cancelado:   R$ ${totalCancelado}`);
console.log(`Modo:              ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
console.log('========================================');

await mongoose.disconnect();
process.exit(0);
