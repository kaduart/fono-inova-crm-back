/**
 * AUDITORIA — Payments fantasmas de pacotes prepaid/full
 *
 * Identifica payments com status 'paid' vinculados a sessões de pacotes
 * pré-pagos (model='prepaid' ou paymentType='full') que NÃO têm isFromPackage=true.
 * Esses são os payments que contaminam o calculateCash do dashboard.
 *
 * Executar: node --env-file=.env scripts/audit-prepaid-ghost-payments.js
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGO_URI não definida'); process.exit(1); }

await mongoose.connect(MONGO_URI);
console.log('✅ Conectado ao MongoDB\n');

const db = mongoose.connection.db;

const noFromPackage = { $or: [{ isFromPackage: { $exists: false } }, { isFromPackage: false }, { isFromPackage: null }] };

// 1a. Payments paid com session (caso particularHandler fallback)
const suspectWithSession = await db.collection('payments').find({
    status: 'paid', amount: { $gt: 0 },
    session: { $exists: true, $ne: null },
    ...noFromPackage
}).project({ _id: 1, amount: 1, paymentDate: 1, financialDate: 1, createdAt: 1, session: 1, appointment: 1, kind: 1, billingType: 1, paymentMethod: 1, notes: 1 }).toArray();

// 1b. Payments paid com note "avulso em sessão de pacote" (caso appointment.v2.js PUT)
const suspectAvulso = await db.collection('payments').find({
    status: 'paid', amount: { $gt: 0 },
    notes: { $regex: 'sessão de pacote', $options: 'i' },
    ...noFromPackage
}).project({ _id: 1, amount: 1, paymentDate: 1, financialDate: 1, createdAt: 1, session: 1, appointment: 1, kind: 1, billingType: 1, paymentMethod: 1, notes: 1 }).toArray();

// Deduplica por _id
const allSuspectMap = new Map([
    ...suspectWithSession.map(p => [p._id.toString(), p]),
    ...suspectAvulso.map(p => [p._id.toString(), p])
]);
const suspectPayments = Array.from(allSuspectMap.values());

console.log(`📦 Payments paid suspeitos (session ou avulso-pacote): ${suspectPayments.length}`);
console.log(`   → Com session: ${suspectWithSession.length}`);
console.log(`   → Avulso em pacote (sem session): ${suspectAvulso.length}\n`);

// 2. Para cada payment suspeito, verifica se a session pertence a pacote prepaid/full
const sessionIds = suspectPayments.map(p => p.session);
const sessions = await db.collection('sessions').find({
    _id: { $in: sessionIds },
    package: { $exists: true, $ne: null }
}).project({ _id: 1, package: 1, paymentOrigin: 1, paymentMethod: 1 }).toArray();

const sessionsThatHavePackage = new Map(sessions.map(s => [s._id.toString(), s]));

const packageIds = sessions.map(s => s.package);
const packages = await db.collection('packages').find({
    _id: { $in: packageIds },
    $or: [
        { model: 'prepaid' },
        { paymentType: 'full' }
    ]
}).project({ _id: 1, model: 1, paymentType: 1, totalValue: 1, totalPaid: 1, sessionsDone: 1, sessionValue: 1 }).toArray();

const prepaidPackageIds = new Set(packages.map(p => p._id.toString()));
const packageMap = new Map(packages.map(p => [p._id.toString(), p]));

// 3. Filtra: (a) session vinculada a pacote prepaid/full OU (b) avulso explícito de pacote
const ghostPayments = suspectPayments.filter(p => {
    // Avulso sem session — note já identifica como sessão de pacote
    if (!p.session) return (p.notes || '').toLowerCase().includes('sessão de pacote');
    const sess = sessionsThatHavePackage.get(p.session.toString());
    if (!sess) return false;
    return prepaidPackageIds.has(sess.package.toString());
});

console.log(`🚨 GHOST PAYMENTS (prepaid/full sem isFromPackage): ${ghostPayments.length}`);
console.log(`   Total em R$: ${ghostPayments.reduce((s, p) => s + p.amount, 0).toFixed(2)}\n`);

if (ghostPayments.length === 0) {
    console.log('✅ Nenhum payment fantasma encontrado!');
    await mongoose.disconnect();
    process.exit(0);
}

// 4. Agrupa por mês para entender impacto histórico
const byMonth = {};
for (const p of ghostPayments) {
    const date = p.financialDate || p.paymentDate || p.createdAt;
    const monthKey = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : 'sem-data';
    if (!byMonth[monthKey]) byMonth[monthKey] = { count: 0, total: 0 };
    byMonth[monthKey].count++;
    byMonth[monthKey].total += p.amount;
}

console.log('📅 Por mês:');
for (const [month, data] of Object.entries(byMonth).sort()) {
    console.log(`   ${month}: ${data.count} payments, R$ ${data.total.toFixed(2)}`);
}

// 5. Detalhes dos payments do mês atual
const now = new Date();
const mesAtual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const thisMonthGhosts = ghostPayments.filter(p => {
    const date = p.financialDate || p.paymentDate || p.createdAt;
    if (!date) return false;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return key === mesAtual;
});

if (thisMonthGhosts.length > 0) {
    console.log(`\n⚠️  Ghost payments do mês atual (${mesAtual}):`);
    for (const p of thisMonthGhosts) {
        const sess = p.session ? sessionsThatHavePackage.get(p.session.toString()) : null;
        const pkg = sess ? packageMap.get(sess.package.toString()) : null;
        console.log(`   Payment ${p._id}: R$${p.amount}, ${p.paymentMethod}, kind=${p.kind}`);
        if (pkg) console.log(`      Pacote: model=${pkg.model}, paymentType=${pkg.paymentType}, totalPaid=${pkg.totalPaid}, sessionsDone=${pkg.sessionsDone}`);
    }
}

console.log('\n📋 Para corrigir os payments fantasmas (REVISAR ANTES DE EXECUTAR):');
console.log('   db.payments.updateMany(');
console.log('     { _id: { $in: [' + ghostPayments.slice(0,3).map(p => `ObjectId("${p._id}")`).join(', ') + (ghostPayments.length > 3 ? ', ...' : '') + '] } },');
console.log('     { $set: { isFromPackage: true } }');
console.log('   )');

await mongoose.disconnect();
