/**
 * Auditoria de datas: qual campo representa o recebimento financeiro real?
 * Para cada LiminarContract, compara createdAt, creditHistory[0].date,
 * e busca evidências de data real de pagamento em documentos relacionados.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

console.log('=== AUDITORIA DE DATAS — QUAL É O RECEBIMENTO REAL? ===\n');

const contracts = await db.collection('liminarcontracts').find({}).sort({ createdAt: 1 }).toArray();

for (const c of contracts) {
    const pid = c.patient;
    const cid = c._id;

    const createdAt = c.createdAt;
    const histDate  = c.creditHistory?.[0]?.createdAt;
    const sameDates = createdAt?.toISOString?.()?.slice(0,10) === histDate?.toISOString?.()?.slice(0,10);

    console.log(`\n[Contrato ${cid.toString().slice(-6)}] patient=${pid?.toString?.()?.slice(-6)}`);
    console.log(`  createdAt:              ${createdAt?.toISOString?.()?.slice(0,10)}`);
    console.log(`  creditHistory[0].date:  ${histDate?.toISOString?.()?.slice(0,10)}`);
    console.log(`  Mesma data?             ${sameDates ? '✅ SIM' : '❌ NÃO — datas diferentes!'}`);
    console.log(`  totalCredit:            R$${c.totalCredit}`);
    console.log(`  processNumber:          ${c.processNumber || '(vazio)'}`);
    console.log(`  court:                  ${c.court || '(vazio)'}`);
    console.log(`  mode:                   ${c.mode || '(vazio)'}`);

    // Busca evidências na coleção packages (modelo antigo, pode ter paymentDate)
    const oldPkg = await db.collection('packages').findOne({
        patient: pid,
        $or: [{ type: 'liminar' }, { model: 'liminar' }]
    });
    if (oldPkg) {
        console.log(`  [Package legado]        createdAt=${oldPkg.createdAt?.toISOString?.()?.slice(0,10)} paymentDate=${oldPkg.paymentDate?.toISOString?.()?.slice(0,10)} status=${oldPkg.status}`);
    } else {
        console.log(`  [Package legado]        nenhum encontrado`);
    }

    // Busca primeiro appointment de liminar desse paciente (pode indicar quando começou)
    const firstApt = await db.collection('appointments').findOne(
        { patient: pid, billingType: 'liminar', liminarContract: cid },
        { sort: { date: 1 } }
    );
    if (firstApt) {
        console.log(`  [1º appointment]        date=${firstApt.date?.toISOString?.()?.slice(0,10)} status=${firstApt.operationalStatus}`);
    }

    // Busca primeiro package_receipt para esse contrato (pode ter data real de pagamento)
    const firstReceipt = await db.collection('payments').findOne(
        { liminarContract: cid, kind: 'package_receipt', status: 'paid' },
        { sort: { createdAt: 1 } }
    );
    if (firstReceipt) {
        console.log(`  [1º package_receipt]    createdAt=${firstReceipt.createdAt?.toISOString?.()?.slice(0,10)} paymentDate=${firstReceipt.paymentDate?.toISOString?.()?.slice(0,10)} financialDate=${firstReceipt.financialDate?.toISOString?.()?.slice(0,10)}`);
    } else {
        console.log(`  [1º package_receipt]    nenhum`);
    }

    // Busca primeiro session_payment para esse contrato
    const firstSession = await db.collection('payments').findOne(
        { liminarContract: cid, kind: 'session_payment', status: 'paid' },
        { sort: { createdAt: 1 } }
    );
    if (firstSession) {
        console.log(`  [1º session_payment]    createdAt=${firstSession.createdAt?.toISOString?.()?.slice(0,10)} financialDate=${firstSession.financialDate?.toISOString?.()?.slice(0,10)}`);
    }

    // Decisão sugerida
    if (!sameDates) {
        const diff = Math.abs(new Date(createdAt) - new Date(histDate)) / (1000 * 60 * 60 * 24);
        console.log(`  ⚠️  DECISÃO NECESSÁRIA: datas diferem ${Math.round(diff)} dias`);
        console.log(`      creditHistory[0].date (${histDate?.toISOString?.()?.slice(0,10)}) = provavelmente data operacional backdatada`);
        console.log(`      createdAt            (${createdAt?.toISOString?.()?.slice(0,10)}) = data real de criação do registro`);
    } else {
        console.log(`  ✅  Datas iguais — financialDate = createdAt = creditHistory[0].date`);
    }
}

// Resumo
console.log('\n\n=== RESUMO COMPARATIVO ===');
const differentDates = contracts.filter(c => {
    const a = c.createdAt?.toISOString?.()?.slice(0,10);
    const b = c.creditHistory?.[0]?.createdAt?.toISOString?.()?.slice(0,10);
    return a !== b;
});
console.log(`Contratos com datas IGUAIS (createdAt = hist[0]):   ${contracts.length - differentDates.length}`);
console.log(`Contratos com datas DIFERENTES:                     ${differentDates.length}`);

if (differentDates.length > 0) {
    console.log('\nContratos com divergência:');
    for (const c of differentDates) {
        console.log(`  ${c._id.toString().slice(-6)}: createdAt=${c.createdAt?.toISOString?.()?.slice(0,10)} vs hist[0]=${c.creditHistory?.[0]?.createdAt?.toISOString?.()?.slice(0,10)} | totalCredit=R$${c.totalCredit}`);
    }
    console.log('\nImpacto no caixa se usarmos creditHistory[0].date:');
    for (const c of differentDates) {
        const histDate = c.creditHistory?.[0]?.createdAt;
        const histMonth = histDate?.toISOString?.()?.slice(0,7);
        const createdMonth = c.createdAt?.toISOString?.()?.slice(0,7);
        if (histMonth !== createdMonth) {
            console.log(`  R$${c.totalCredit} migra de ${createdMonth} → ${histMonth}`);
        }
    }
}

await mongoose.disconnect();
console.log('\n=== FIM ===');
