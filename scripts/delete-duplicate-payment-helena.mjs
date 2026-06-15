/**
 * Cleanup pontual: remove payment duplicado da Helena (14:40, Dinheiro)
 * gerado pelo particularHandler antes do fix do orphan guard (2026-06-15).
 *
 * Critério: patient com nome "Helena", amount=170, paymentMethod=dinheiro/cash,
 * criado em 2026-06-15, status=paid — é o duplicado gerado pelo complete às 14:40.
 *
 * Executar: node --env-file=.env scripts/delete-duplicate-payment-helena.mjs
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não definida');
    process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log('✅ Conectado ao MongoDB');

const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
const Patient = mongoose.model('Patient', new mongoose.Schema({}, { strict: false }));

// 1. Encontra a Helena
const helena = await Patient.findOne({
    fullName: { $regex: /helena pedro bezerra/i }
}).lean();

if (!helena) {
    console.error('❌ Paciente Helena Pedro Bezerra não encontrada');
    process.exit(1);
}

console.log(`\nPaciente encontrada: ${helena.fullName} (${helena._id})`);

// 2. Busca todos os payments dela hoje
const startOfDay = new Date('2026-06-15T00:00:00.000Z');
const endOfDay   = new Date('2026-06-15T23:59:59.999Z');

const payments = await Payment.find({
    patient: helena._id,
    amount:  170,
    financialDate: { $gte: startOfDay, $lte: endOfDay }
}).sort({ createdAt: 1 }).lean();

console.log(`\nPayments encontrados (${payments.length}):`);
payments.forEach((p, i) => {
    console.log(`  [${i + 1}] _id=${p._id}  method=${p.paymentMethod}  status=${p.status}  financialDate=${p.financialDate}  createdAt=${p.createdAt}  appointment=${p.appointment}`);
});

if (payments.length < 2) {
    console.log('\n⚠️  Menos de 2 payments encontrados — nada a remover.');
    await mongoose.disconnect();
    process.exit(0);
}

// 3. Identifica o duplicado: paymentMethod dinheiro/cash (o legítimo é pix)
const duplicate = payments.find(p => ['dinheiro', 'cash', 'money'].includes(p.paymentMethod?.toLowerCase()));

if (!duplicate) {
    console.error('\n❌ Não foi possível identificar o duplicado automaticamente. Verifique manualmente.');
    console.log('   Dica: o duplicado é o que foi criado às ~14:40 com paymentMethod=dinheiro/cash.');
    await mongoose.disconnect();
    process.exit(1);
}

console.log(`\n🗑️  Duplicado identificado:`);
console.log(`   _id:          ${duplicate._id}`);
console.log(`   method:       ${duplicate.paymentMethod}`);
console.log(`   financialDate:${duplicate.financialDate}`);
console.log(`   createdAt:    ${duplicate.createdAt}`);
console.log(`   appointment:  ${duplicate.appointment}`);

// 4. Remove o duplicado
const result = await Payment.deleteOne({ _id: duplicate._id });

if (result.deletedCount === 1) {
    console.log('\n✅ Payment duplicado removido com sucesso.');
} else {
    console.error('\n❌ Remoção falhou — verifique manualmente.');
}

await mongoose.disconnect();
console.log('Desconectado.\n');
