/**
 * 🏥 BACKFILL: Insurance Payments → FinancialLedger
 *
 * Popula:
 * - insurance_billed  (Payment.insurance.status === 'billed')
 * - insurance_received (Payment.insurance.status === 'received')
 *
 * Regras:
 * - Idempotente: correlationId = `insurance_{paymentId}_{billed|received}`
 * - Safe re-run
 * - Reconciliation-aware
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';
import FinancialLedger from '../models/FinancialLedger.js';
import { recordInsuranceBilled, recordInsuranceReceived } from '../services/financialLedgerService.js';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`[Backfill Insurance] Conectado. Dry-run: ${DRY_RUN}`);

    // ───────────────────────────────────────────────
    // 1. BILLED
    // ───────────────────────────────────────────────
    const billedPayments = await Payment.find({
        billingType: 'convenio',
        'insurance.status': 'billed'
    }).lean();

    let billedCreated = 0;
    let billedSkipped = 0;
    let billedErrors = 0;

    for (const payment of billedPayments) {
        const correlationId = `insurance_${payment._id}_billed`;
        try {
            const exists = await FinancialLedger.findOne({ type: 'insurance_billed', correlationId }).lean();
            if (exists) {
                billedSkipped++;
                continue;
            }
            if (DRY_RUN) {
                console.log(`[DRY-RUN] Billed: payment=${payment._id} provider=${payment.insurance?.provider} amount=${payment.insurance?.grossAmount || payment.amount}`);
                billedCreated++;
                continue;
            }
            await recordInsuranceBilled(payment, { correlationId, billedAt: payment.insurance?.billedAt });
            billedCreated++;
        } catch (err) {
            billedErrors++;
            console.error(`[Backfill Insurance] ❌ Erro billed ${payment._id}:`, err.message);
        }
    }

    // ───────────────────────────────────────────────
    // 2. RECEIVED
    // ───────────────────────────────────────────────
    const receivedPayments = await Payment.find({
        billingType: 'convenio',
        'insurance.status': 'received'
    }).lean();

    let receivedCreated = 0;
    let receivedSkipped = 0;
    let receivedErrors = 0;

    for (const payment of receivedPayments) {
        const correlationId = `insurance_${payment._id}_received`;
        try {
            const exists = await FinancialLedger.findOne({ type: 'insurance_received', correlationId }).lean();
            if (exists) {
                receivedSkipped++;
                continue;
            }
            if (DRY_RUN) {
                console.log(`[DRY-RUN] Received: payment=${payment._id} provider=${payment.insurance?.provider} amount=${payment.insurance?.receivedAmount || payment.amount}`);
                receivedCreated++;
                continue;
            }
            await recordInsuranceReceived(payment, { correlationId, receivedAt: payment.insurance?.receivedAt });
            receivedCreated++;
        } catch (err) {
            receivedErrors++;
            console.error(`[Backfill Insurance] ❌ Erro received ${payment._id}:`, err.message);
        }
    }

    // ───────────────────────────────────────────────
    // RECONCILIAÇÃO
    // ───────────────────────────────────────────────
    const ledgerBilled = await FinancialLedger.countDocuments({ type: 'insurance_billed' });
    const ledgerReceived = await FinancialLedger.countDocuments({ type: 'insurance_received' });
    const billedTotal = await FinancialLedger.aggregate([
        { $match: { type: 'insurance_billed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const receivedTotal = await FinancialLedger.aggregate([
        { $match: { type: 'insurance_received' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    console.log('\n========================================');
    console.log('RESUMO BACKFILL INSURANCE');
    console.log('========================================');
    console.log(`Payments billed no DB:     ${billedPayments.length}`);
    console.log(`Ledger insurance_billed:   ${ledgerBilled}`);
    console.log(`Criados billed:            ${billedCreated} | Pulados: ${billedSkipped} | Erros: ${billedErrors}`);
    console.log(`Payments received no DB:   ${receivedPayments.length}`);
    console.log(`Ledger insurance_received: ${ledgerReceived}`);
    console.log(`Criados received:          ${receivedCreated} | Pulados: ${receivedSkipped} | Erros: ${receivedErrors}`);
    console.log(`Total billed (R$):         ${billedTotal[0]?.total || 0}`);
    console.log(`Total received (R$):       ${receivedTotal[0]?.total || 0}`);
    console.log('========================================\n');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Backfill Insurance] 💥 Erro fatal:', err);
    process.exit(1);
});
