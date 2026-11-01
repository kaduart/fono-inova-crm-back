/**
 * migrate-liminar-financial.mjs
 *
 * Migra o modelo financeiro de Liminar de "por sessão" para "por contrato".
 *
 * O QUE FAZ:
 *   1. Verifica se algum payment a cancelar está vinculado a Invoice (safety gate)
 *   2. Para cada LiminarContract sem liminar_contract_receipt:
 *      - Calcula financialDate pela hierarquia de verdade
 *      - Cria Payment liminar_contract_receipt
 *   3. Cancela session_payment e package_receipt de liminar (status→canceled)
 *      via updateMany direto (bypassa cancelPayment.js que bloqueia session_payment)
 *
 * RODAR COM DRY_RUN=true PRIMEIRO:
 *   DRY_RUN=true node migrate-liminar-financial.mjs
 *   node migrate-liminar-financial.mjs
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

console.log(`=== MIGRAÇÃO FINANCEIRA LIMINAR ${DRY_RUN ? '[DRY-RUN]' : '[REAL]'} ===\n`);

// ── 1. SAFETY GATE: Invoices vinculadas a payments que serão cancelados ────
console.log('--- PASSO 1: Verificação de Invoices ---');

const paymentsToCancel = await db.collection('payments').find({
    $or: [{ billingType: 'liminar' }, { paymentMethod: { $regex: /liminar/i } }],
    kind: { $in: ['session_payment', 'package_receipt'] },
    status: 'paid'
}).toArray();

const paymentIds = paymentsToCancel.map(p => p._id);

const linkedInvoices = await db.collection('invoices').find({
    $or: [
        { payment: { $in: paymentIds } },
        { payments: { $in: paymentIds } },
        { relatedPayments: { $in: paymentIds } }
    ]
}).toArray();

if (linkedInvoices.length > 0) {
    console.log(`\n⛔ BLOQUEADO: ${linkedInvoices.length} Invoice(s) vinculadas a payments que seriam cancelados.`);
    console.log('Resolva as Invoices antes de rodar a migração:');
    linkedInvoices.forEach(inv => console.log(`  Invoice ${inv._id}`));
    await mongoose.disconnect();
    process.exit(1);
}

console.log(`✅ Nenhuma Invoice vinculada. Seguro prosseguir.\n`);

// ── 2. CRIAR liminar_contract_receipt por contrato ─────────────────────────
console.log('--- PASSO 2: Criar liminar_contract_receipt ---');

const contracts = await db.collection('liminarcontracts').find({}).sort({ createdAt: 1 }).toArray();

let created = 0, skipped = 0;

for (const c of contracts) {
    const existing = await db.collection('payments').findOne({
        liminarContract: c._id,
        kind: 'liminar_contract_receipt'
    });

    if (existing) {
        console.log(`  SKIP ${c._id.toString().slice(-6)}: já tem liminar_contract_receipt`);
        skipped++;
        continue;
    }

    // Buscar package_receipt como evidência primária da data
    const receipt = await db.collection('payments').findOne(
        { liminarContract: c._id, kind: 'package_receipt', status: 'paid' },
        { sort: { paymentDate: 1 } }
    );

    const financialDate =
        receipt?.paymentDate ||
        c.receivedAt ||
        c.creditHistory?.find(h => h.type === 'initial')?.createdAt ||
        c.createdAt;

    const paymentDoc = {
        patient:         c.patient,
        doctor:          c.doctor,
        amount:          c.totalCredit,
        status:          'paid',
        kind:            'liminar_contract_receipt',
        billingType:     'liminar',
        paymentMethod:   'liminar_credit',
        paymentDate:     financialDate,
        financialDate:   financialDate,
        liminarContract: c._id,
        isFromPackage:   false,
        notes:           c.processNumber ? `Processo: ${c.processNumber}` : 'Migração financeira 2026-06',
        createdAt:       new Date(),
        updatedAt:       new Date(),
    };

    console.log(`  [${DRY_RUN ? 'DRY' : 'CRIAR'}] Contract ...${c._id.toString().slice(-6)} | R$${c.totalCredit} | financialDate=${financialDate?.toISOString?.()?.slice(0,10)} | fonte=${receipt ? 'package_receipt' : c.receivedAt ? 'receivedAt' : 'creditHistory'}`);

    if (!DRY_RUN) {
        await db.collection('payments').insertOne(paymentDoc);
        created++;
    } else {
        created++;
    }
}

console.log(`\nReceipts ${DRY_RUN ? 'que seriam criados' : 'criados'}: ${created}, pulados: ${skipped}\n`);

// ── 3. CANCELAR session_payment e package_receipt de liminar ───────────────
console.log('--- PASSO 3: Cancelar session_payment e package_receipt liminar ---');

console.log(`  Payments a cancelar: ${paymentsToCancel.length} (${paymentsToCancel.filter(p => p.kind === 'session_payment').length} session_payment + ${paymentsToCancel.filter(p => p.kind === 'package_receipt').length} package_receipt)`);

const totalToCancelValue = paymentsToCancel.reduce((acc, p) => acc + (p.amount || 0), 0);
console.log(`  Valor total a retirar do caixa: R$${totalToCancelValue.toFixed(2)}`);

if (!DRY_RUN) {
    const result = await db.collection('payments').updateMany(
        {
            _id: { $in: paymentIds },
        },
        {
            $set: {
                status: 'canceled',
                canceledAt: new Date(),
                canceledReason: 'Migração financeira: liminar pré-paga reconhecida no contrato',
                updatedAt: new Date()
            }
        }
    );
    console.log(`  Cancelados: ${result.modifiedCount} payments`);
} else {
    console.log(`  [DRY-RUN] ${paymentsToCancel.length} payments seriam cancelados`);
}

// ── SUMÁRIO ────────────────────────────────────────────────────────────────
console.log('\n=== SUMÁRIO ===');
console.log(`Contratos processados:       ${contracts.length}`);
console.log(`Receipts ${DRY_RUN ? 'a criar' : 'criados'}:            ${created}`);
console.log(`Payments ${DRY_RUN ? 'a cancelar' : 'cancelados'}:       ${paymentsToCancel.length}`);
console.log(`Impacto líquido no caixa:    +R$${(contracts.reduce((a, c) => a + (c.totalCredit || 0), 0) - totalToCancelValue).toFixed(2)}`);

if (DRY_RUN) {
    console.log('\n⚠️  DRY-RUN concluído. Para executar de verdade:');
    console.log('   DRY_RUN=false node migrate-liminar-financial.mjs');
}

await mongoose.disconnect();
console.log('\n=== FIM ===');
