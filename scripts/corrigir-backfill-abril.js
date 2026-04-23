// scripts/corrigir-backfill-abril.js
// ============================================================
// CORRIGE backfill de abril: sessions de pacote devem ter
// billingType 'prepaid' (não 'particular') para não duplicar caixa
//
// Uso: node scripts/corrigir-backfill-abril.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';

dotenv.config();

const DRY_RUN = process.argv.includes('dry-run');

async function main() {
    console.log(`[Corrigir Backfill Abril] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);
    console.log('[Corrigir Backfill Abril] Conectado ao MongoDB');

    const today = new Date('2026-04-19T00:00:00-03:00');

    // Buscar payments criados hoje com session vinculada
    const payments = await Payment.find({
        createdAt: { $gte: today },
        session: { $exists: true, $ne: null }
    }).lean();

    console.log(`[Corrigir Backfill Abril] Total payments criados hoje: ${payments.length}`);

    // Buscar sessions e packages
    const sessionIds = payments.map(p => p.session.toString());
    const sessions = await Session.find({ _id: { $in: sessionIds } }).select('package').lean();
    const sessionMap = {};
    for (const s of sessions) sessionMap[s._id.toString()] = s;

    const packageIds = sessions.map(s => s.package).filter(id => id);
    const packages = await Package.find({ _id: { $in: packageIds } }).select('model paymentType type').lean();
    const packageMap = {};
    for (const p of packages) packageMap[p._id.toString()] = p;

    let corrigidos = 0;
    let mantidos = 0;
    let erros = 0;

    for (const p of payments) {
        try {
            const session = sessionMap[p.session.toString()];
            if (!session) {
                console.log(`[SKIP] Payment ${p._id}: session não encontrada`);
                continue;
            }

            const pkg = session.package ? packageMap[session.package.toString()] : null;
            const isPackage = !!pkg;

            if (!isPackage) {
                // Avulso — manter como particular
                console.log(`[MANTIDO] Payment ${p._id}: avulso, billingType='particular'`);
                mantidos++;
                continue;
            }

            // Pacote — corrigir para prepaid
            const model = pkg.model || pkg.paymentType || pkg.type || 'prepaid';
            const newBillingType = model === 'convenio' ? 'convenio' : 'prepaid';
            const newKind = 'package_consumed';

            if (DRY_RUN) {
                console.log(`[DRY-RUN] Corrigir Payment ${p._id}: ${p.billingType || 'null'} → ${newBillingType}, kind: ${newKind}, amount: ${p.amount}`);
            } else {
                await Payment.findByIdAndUpdate(p._id, {
                    $set: {
                        billingType: newBillingType,
                        kind: newKind,
                        status: 'consumed',
                        isFromPackage: true,
                        notes: `[CORREÇÃO BACKFILL: ajustado de '${p.billingType || 'null'}' para '${newBillingType}' para evitar duplicação de caixa] ${p.notes || ''}`.trim(),
                        updatedAt: new Date()
                    },
                    $unset: { paidAt: "" }
                });
                console.log(`[CORRIGIDO] Payment ${p._id}: ${p.billingType || 'null'} → ${newBillingType}, kind: ${newKind}`);
            }
            corrigidos++;

        } catch (err) {
            console.error(`[ERRO] Payment ${p._id}:`, err.message);
            erros++;
        }
    }

    console.log('\n========================================');
    console.log('[Corrigir Backfill Abril] RESUMO');
    console.log('========================================');
    console.log(`Total analisado:  ${payments.length}`);
    console.log(`Corrigidos:       ${corrigidos}`);
    console.log(`Mantidos (avulso):${mantidos}`);
    console.log(`Erros:            ${erros}`);
    console.log(`Modo:             ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Corrigir Backfill Abril] Erro fatal:', err);
    process.exit(1);
});
