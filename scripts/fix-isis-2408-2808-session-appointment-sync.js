#!/usr/bin/env node
/**
 * Reparo cirúrgico pós-incidente: revert-isis-2408-2808.js já reverteu
 * corretamente o Payment (paid→pending) e lançou o débito no PatientBalance,
 * mas Session.isPaid/Appointment.isPaid das duas sessões (24/08, 28/08)
 * ficaram com o valor ANTIGO (true) porque o plugin `financialSanitizer`
 * (models/plugins/financialSanitizer.js) descarta silenciosamente
 * isPaid/paymentStatus de updates que não levam
 * { __fromFinancialGuard: true, __guardContext: 'FINANCIAL' } nas options —
 * exatamente o mesmo bug já documentado e corrigido em
 * incorporatePackagePayments() (ver DOMAIN_INVARIANTS.md, ADR-019, item 4).
 * O script original não tinha essas options; este aqui só completa o que
 * ficou faltando, sem tocar em Payment/PatientBalance/FinancialLedger de novo
 * (já estão corretos).
 *
 * Uso:
 *   node scripts/fix-isis-2408-2808-session-appointment-sync.js           → dry-run
 *   node scripts/fix-isis-2408-2808-session-appointment-sync.js --apply   → aplica de verdade
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

import '../models/index.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';

const APPLY = process.argv.includes('--apply');

const PATIENT_ID = '685b0cfaaec14c7163585b5b'; // Isis Caldas Rebelatto
const PACKAGE_ID = '6a746daaf69cb76a5e463a38';

const TARGETS = [
    { label: '24/08', paymentId: '6a8c91733f3e96ae214a136c' },
    { label: '28/08', paymentId: '6abab9d07e9298d6a27d6d20' }
];

async function main() {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('MONGODB_URI/MONGO_URI não encontrado');
        process.exit(1);
    }
    await mongoose.connect(mongoUri);
    console.log(`Conectado. Modo: ${APPLY ? '⚠️  APPLY (vai escrever)' : '🔍 DRY-RUN (nada será escrito)'}\n`);

    let syncedCount = 0;

    for (const target of TARGETS) {
        console.log(`\n=== ${target.label} — payment ${target.paymentId} ===`);
        const payment = await Payment.findById(target.paymentId).lean();
        if (!payment) {
            console.log('  ❌ Payment não encontrado, pulando.');
            continue;
        }
        if (payment.patient?.toString() !== PATIENT_ID) {
            console.log(`  ⚠️  Payment não pertence à Isis (patient=${payment.patient}). Pulando por segurança.`);
            continue;
        }
        if (payment.status !== 'pending') {
            console.log(`  ⚠️  Payment.status='${payment.status}' (esperado 'pending' — o revert já deveria ter rodado). Pulando por segurança — confira antes de reparar Session/Appointment.`);
            continue;
        }
        console.log(`  Payment: OK (status=pending, paidAt=${payment.paidAt}, financialDate=${payment.financialDate})`);

        if (payment.session) {
            const session = await Session.findById(payment.session).select('isPaid paymentStatus').lean();
            console.log(`  Session ${payment.session}: isPaid=${session?.isPaid} paymentStatus=${session?.paymentStatus}`);
            if (session?.isPaid === false) {
                console.log('    ℹ️  Já está isPaid:false — nada a fazer.');
            } else {
                console.log('    → vai corrigir: isPaid:false, paymentStatus:unpaid (com bypass do financialSanitizer)');
                if (APPLY) {
                    await Session.findByIdAndUpdate(
                        payment.session,
                        { $set: { isPaid: false, paymentStatus: 'unpaid', paymentOrigin: 'manual_balance' } },
                        { __fromFinancialGuard: true, __guardContext: 'FINANCIAL', new: true }
                    );
                    console.log('    ✅ Session corrigida.');
                }
                syncedCount++;
            }
        }

        if (payment.appointment) {
            const appt = await Appointment.findById(payment.appointment).select('isPaid paymentStatus operationalStatus').lean();
            console.log(`  Appointment ${payment.appointment}: isPaid=${appt?.isPaid} paymentStatus=${appt?.paymentStatus} operationalStatus=${appt?.operationalStatus} (não alterado — continua completed)`);
            if (appt?.isPaid === false) {
                console.log('    ℹ️  Já está isPaid:false — nada a fazer.');
            } else {
                console.log('    → vai corrigir: isPaid:false, paymentStatus:unpaid (com bypass do financialSanitizer) — operationalStatus NÃO é tocado');
                if (APPLY) {
                    await Appointment.findByIdAndUpdate(
                        payment.appointment,
                        { $set: { isPaid: false, paymentStatus: 'unpaid' } },
                        { __fromFinancialGuard: true, __guardContext: 'FINANCIAL' }
                    );
                    console.log('    ✅ Appointment corrigido.');
                }
            }
        }
    }

    console.log(`\n=== Recalculando pacote ${PACKAGE_ID} ===`);
    const pkg = await Package.findById(PACKAGE_ID);
    if (pkg) {
        // Em dry-run, Session ainda não foi corrigida no banco — soma manualmente
        // a projeção (paidCount real menos as que vamos corrigir) pra não repetir
        // o mesmo erro de projeção do script anterior.
        const currentPaidCount = await Session.countDocuments({ package: pkg._id, isPaid: true });
        const stillCountedToFix = APPLY ? 0 : syncedCount;
        const paidCount = currentPaidCount - stillCountedToFix;
        const consumedValue = paidCount * (pkg.sessionValue || 0);
        const totalPaid = consumedValue;
        const balance = Math.max(0, (pkg.totalValue || 0) - totalPaid);
        let financialStatus = 'unpaid';
        if (balance <= 0 && totalPaid > 0) financialStatus = 'paid';
        else if (totalPaid > 0) financialStatus = 'partially_paid';

        console.log(`  paidCount=${paidCount} | consumedValue=${consumedValue}`);
        console.log(`  totalPaid: ${pkg.totalPaid} → ${totalPaid} | balance: ${pkg.balance} → ${balance} | financialStatus: ${pkg.financialStatus} → ${financialStatus}`);

        if (APPLY) {
            await Package.updateOne(
                { _id: pkg._id },
                { $set: { totalPaid, consumedValue, balance, financialStatus, updatedAt: new Date() } }
            );
            console.log('  ✅ Pacote recalculado.');
        }
    } else {
        console.log('  ❌ Pacote não encontrado.');
    }

    console.log(`\n${APPLY ? '✅ Concluído (dados corrigidos).' : '🔍 Dry-run concluído. Rode com --apply para aplicar de verdade.'}`);
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
