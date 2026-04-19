// scripts/reconciliacao-particular-marco-legado.js
// ============================================================
// MARCA COMO PAID os payments PARTICULAR de MARÇO/2026
// que foram pagos pelo sistema legado (balance/carteira)
// mas não atualizaram o Payment.
//
// Uso: node scripts/reconciliacao-particular-marco-legado.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Payment from '../models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const DRY_RUN = process.argv.includes('dry-run');

const MARCO_START = moment.tz('2026-03-01', TIMEZONE).startOf('day').toDate();
const MARCO_END = moment.tz('2026-03-31', TIMEZONE).endOf('day').toDate();

async function main() {
    console.log(`[Particular Março Legado] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);

    // Buscar payments particular pending de MARÇO/2026
    // paymentDate é Date (ISODate) no banco
    const pendingPayments = await Payment.find({
        status: 'pending',
        billingType: 'particular',
        amount: { $gt: 0 },
        paymentDate: { $gte: MARCO_START, $lte: MARCO_END }
    }).select('_id amount paymentDate patient session appointment').lean();

    console.log(`[Particular Março Legado] Encontrados ${pendingPayments.length} payments particular pending de março`);

    let atualizados = 0;
    let skipped = 0;

    for (const p of pendingPayments) {
        const dataStr = moment(p.paymentDate).tz(TIMEZONE).format('YYYY-MM-DD');

        // PULA o dia 30 se você quer deixar ele como pending
        // (você disse que só o dia 30 não foi pago)
        if (dataStr === '2026-03-30') {
            console.log(`[SKIP] Payment ${p._id}: R$ ${p.amount} — dia 30 (você disse que não foi pago)`);
            skipped++;
            continue;
        }

        if (DRY_RUN) {
            console.log(`[DRY-RUN] Atualizaria Payment ${p._id}: R$ ${p.amount} | data=${dataStr} → status: paid`);
        } else {
            await Payment.findByIdAndUpdate(p._id, {
                $set: {
                    status: 'paid',
                    paidAt: new Date(),
                    financialDate: p.paymentDate, // usa a data original do atendimento
                    notes: `[RECONCILIAÇÃO: pago via legado/balance em ${moment().format('YYYY-MM-DD')}] ${p.notes || ''}`.trim(),
                    updatedAt: new Date()
                }
            });
            console.log(`[ATUALIZADO] Payment ${p._id}: R$ ${p.amount} | data=${dataStr} → status: paid`);
        }
        atualizados++;
    }

    console.log('\n========================================');
    console.log('[Particular Março Legado] RESUMO');
    console.log('========================================');
    console.log(`Total analisado:  ${pendingPayments.length}`);
    console.log(`Atualizados→paid: ${atualizados}`);
    console.log(`Skipped (dia 30): ${skipped}`);
    console.log(`Modo:             ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Particular Março Legado] Erro fatal:', err);
    process.exit(1);
});
