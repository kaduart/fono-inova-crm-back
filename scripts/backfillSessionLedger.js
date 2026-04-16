/**
 * 🏦 BACKFILL: Session → FinancialLedger (revenue_recognition)
 *
 * Regras:
 * - Idempotente: correlationId fixo (sessionId + '_revenue_recognition')
 * - Safe re-run: ignora sessões que já têm ledger
 * - Dry-run: mostra o que faria sem escrever
 * - Reconciliation-aware: gera diff report no final
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import FinancialLedger from '../models/FinancialLedger.js';
import Package from '../models/Package.js';
import { recordSessionRevenue } from '../services/financialLedgerService.js';
import { resolveSessionBillingType } from '../utils/billingHelpers.js';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 100;

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`[Backfill] Conectado. Dry-run: ${DRY_RUN}`);

    const totalSessions = await Session.countDocuments({ status: 'completed' });
    console.log(`[Backfill] Total de sessões completed: ${totalSessions}`);

    let processed = 0;
    let created = 0;
    let skipped = 0;
    let errors = 0;

    let cursor = Session.find({ status: 'completed' })
        .populate('patient', 'fullName')
        .populate('package', 'insuranceProvider insuranceCompany insuranceGrossAmount type')
        .cursor();

    for (let session = await cursor.next(); session != null; session = await cursor.next()) {
        processed++;
        const correlationId = `session_${session._id}_revenue_recognition`;

        try {
            const exists = await FinancialLedger.findOne({
                type: 'revenue_recognition',
                correlationId
            }).lean();

            if (exists) {
                skipped++;
                continue;
            }

            const billingType = resolveSessionBillingType(session);
            const amount = session.package?.insuranceGrossAmount || session.sessionValue || 0;

            if (DRY_RUN) {
                console.log(`[DRY-RUN] Criaria ledger: session=${session._id} billingType=${billingType} amount=${amount}`);
                created++;
                continue;
            }

            await recordSessionRevenue(session, {
                correlationId,
                userId: null,
                userName: 'backfill_system'
            });
            created++;

            if (processed % BATCH_SIZE === 0) {
                console.log(`[Backfill] Progresso: ${processed}/${totalSessions} (criados: ${created}, pulados: ${skipped}, erros: ${errors})`);
            }
        } catch (err) {
            errors++;
            console.error(`[Backfill] ❌ Erro na sessão ${session._id}:`, err.message);
        }
    }

    await cursor.close();

    // ───────────────────────────────────────────────
    // RECONCILIAÇÃO: Session.completed vs Ledger
    // ───────────────────────────────────────────────
    console.log('\n[Backfill] Iniciando reconciliação...');

    const ledgerCount = await FinancialLedger.countDocuments({ type: 'revenue_recognition' });
    const diff = totalSessions - ledgerCount;

    const recon = await FinancialLedger.aggregate([
        { $match: { type: 'revenue_recognition' } },
        {
            $group: {
                _id: '$billingType',
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        }
    ]);

    console.log('\n========================================');
    console.log('RESUMO BACKFILL');
    console.log('========================================');
    console.log(`Sessões completed:     ${totalSessions}`);
    console.log(`Ledger revenue_recognition: ${ledgerCount}`);
    console.log(`Processadas:           ${processed}`);
    console.log(`Criadas:               ${created}`);
    console.log(`Puladas (já existiam): ${skipped}`);
    console.log(`Erros:                 ${errors}`);
    console.log(`Divergência count:     ${diff}`);
    console.log('\nReconciliação por billingType:');
    recon.forEach(r => {
        console.log(`  ${r._id || 'unknown'}: ${r.count} sessões = R$ ${r.total.toFixed(2)}`);
    });
    console.log('========================================\n');

    await mongoose.disconnect();
    process.exit(diff === 0 && errors === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('[Backfill] 💥 Erro fatal:', err);
    process.exit(1);
});
