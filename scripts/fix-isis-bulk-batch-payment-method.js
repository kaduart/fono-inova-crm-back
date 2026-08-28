#!/usr/bin/env node
/**
 * FIX: corrige o lote inteiro de "Pagamento em Lote" da Isis (16 sessões +
 * 1 registro-resumo "monthly_settlement") feito hoje via modal Sessões em
 * Aberto -> Pagamento em Lote. O valor real foi PIX R$42 + Cartão de Crédito
 * R$2.368 (resto), mas o bug em normalizePaymentMethod (payment.v2.js) não
 * reconhecia 'cartao_credito' e caía no fallback 'dinheiro'/'cash' -- e essa
 * mesma alocação incorreta foi distribuída por allocateSplitMethods entre
 * todos os 16 Payments do lote + espelhada nos Appointments vinculados.
 *
 * Já corrigido manualmente antes: Payment 6a5e719dce43485b2af53897 (o único
 * que tinha split de verdade, pix+cartao). Este script corrige os 15
 * restantes (pagamento único "dinheiro" -> "credit_card"/"cartao_credito")
 * + o registro agregado do settlement.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';

// [paymentId, paymentSplitEntryId, appointmentId, apptFormEntryId]
const ITEMS = [
  ["6a5e71cfce43485b2af53979","6a91db23840b39a658af1b84","6a343f4e9dcf417d494e373e","6a91db24840b39a658af1b96"],
  ["6a67bac5ba74694dae1b4ab3","6a91db23840b39a658af1b85","6a1d9f1c4bafb710ab15bc8a","6a91db24840b39a658af1b97"],
  ["6a67c4a3ba74694dae1b522d","6a91db23840b39a658af1b86","6a63b3c426994a284eab25ba","6a91db24840b39a658af1b98"],
  ["6a70e030a4eafff81d335c59","6a91db23840b39a658af1b87","69e2730d11988055724866f2","6a91db24840b39a658af1b99"],
  ["6a70e9c799a6ed30c5317335","6a91db23840b39a658af1b88","69e2724d119880557248659b","6a91db24840b39a658af1b9a"],
  ["6a762d74b85b940800d21ebc","6a91db23840b39a658af1b89","6a343eeb9dcf417d494e35e2","6a91db24840b39a658af1b9b"],
  ["6a762dfdb85b940800d22156","6a91db23840b39a658af1b8a","6a746dabf69cb76a5e463a41","6a91db24840b39a658af1b9c"],
  ["6a7a17625d8258e6a39cb66c","6a91db23840b39a658af1b8b","6a746dabf69cb76a5e463a42","6a91db24840b39a658af1b9d"],
  ["6a7a217a5d8258e6a39cbcbe","6a91db23840b39a658af1b8c","6a746ed5f69cb76a5e463dfd","6a91db24840b39a658af1b9e"],
  ["6a7f754cf642420dd20cf51c","6a91db23840b39a658af1b8d","6a746dabf69cb76a5e463a43","6a91db24840b39a658af1b9f"],
  ["6a7f7567f642420dd20cf604","6a91db23840b39a658af1b8e","6a7f5b001356b5ac803b1434","6a91db24840b39a658af1ba0"],
  ["6a835d052abf3e76324b5889","6a91db23840b39a658af1b8f","6a746dabf69cb76a5e463a44","6a91db24840b39a658af1ba1"],
  ["6a888fbc8650baf1b0867b52","6a91db23840b39a658af1b90","6a7f5b001356b5ac803b1435","6a91db24840b39a658af1ba2"],
  ["6a88998b8650baf1b086812a","6a91db23840b39a658af1b91","6a746dabf69cb76a5e463a45","6a91db24840b39a658af1ba3"],
  ["6a8c91733f3e96ae214a136c","6a91db23840b39a658af1b92","6a746dabf69cb76a5e463a46","6a91db24840b39a658af1ba4"],
];
const AGGREGATE_PAYMENT_ID = "6a91db24840b39a658af1ba7";
const AGGREGATE_SPLIT_ENTRY_ID = "6a91db24840b39a658af1ba9";

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    await mongoose.connect(uri);
    console.log(`[FIX] Conectado. Modo: ${DRY_RUN ? 'DRY-RUN (nenhuma escrita)' : 'ESCRITA REAL'}\n`);

    let paymentsFixed = 0, apptsFixed = 0;

    for (const [paymentId, splitEntryId, apptId, formEntryId] of ITEMS) {
        const paymentFilter = { _id: paymentId, 'splitMethods._id': splitEntryId, paymentMethod: 'dinheiro' };
        const paymentUpdate = { $set: { 'splitMethods.$.method': 'credit_card', paymentMethod: 'credit_card' } };
        if (DRY_RUN) {
            const matches = await Payment.countDocuments(paymentFilter);
            console.log(`[DRY-RUN] Payment ${paymentId}: ${matches === 1 ? 'MUDARIA (dinheiro -> credit_card)' : `NAO CASOU (matches=${matches})`}`);
            if (matches === 1) paymentsFixed++;
        } else {
            const pRes = await Payment.updateOne(paymentFilter, paymentUpdate);
            if (pRes.modifiedCount === 1) paymentsFixed++;
            else console.log(`  AVISO: Payment ${paymentId} nao modificado (matched=${pRes.matchedCount}) - verificar manualmente`);
        }

        const apptFilter = { _id: apptId, 'paymentForms._id': formEntryId, paymentMethod: 'dinheiro' };
        const apptUpdate = { $set: { 'paymentForms.$.method': 'cartao_credito', paymentMethod: 'cartao_credito' } };
        if (DRY_RUN) {
            const matches = await Appointment.countDocuments(apptFilter);
            console.log(`[DRY-RUN] Appointment ${apptId}: ${matches === 1 ? 'MUDARIA (dinheiro -> cartao_credito)' : `NAO CASOU (matches=${matches})`}`);
            if (matches === 1) apptsFixed++;
        } else {
            const aRes = await Appointment.updateOne(apptFilter, apptUpdate);
            if (aRes.modifiedCount === 1) apptsFixed++;
            else console.log(`  AVISO: Appointment ${apptId} nao modificado (matched=${aRes.matchedCount}) - verificar manualmente`);
        }
    }

    const aggFilter = { _id: AGGREGATE_PAYMENT_ID, 'splitMethods._id': AGGREGATE_SPLIT_ENTRY_ID };
    if (DRY_RUN) {
        const matches = await Payment.countDocuments(aggFilter);
        console.log(`\n[DRY-RUN] Aggregate ${AGGREGATE_PAYMENT_ID}: ${matches === 1 ? 'MUDARIA (dinheiro -> credit_card)' : `NAO CASOU (matches=${matches})`}`);
    } else {
        const aggRes = await Payment.updateOne(aggFilter, { $set: { 'splitMethods.$.method': 'credit_card' } });
        console.log(`\n[FIX] Aggregate settlement update: ${JSON.stringify(aggRes)}`);
    }

    console.log(`\n[FIX] Payments ${DRY_RUN ? 'que mudariam' : 'corrigidos'}: ${paymentsFixed}/${ITEMS.length}`);
    console.log(`[FIX] Appointments ${DRY_RUN ? 'que mudariam' : 'corrigidos'}: ${apptsFixed}/${ITEMS.length}`);

    if (!DRY_RUN) {
        console.log('\n=== VERIFICACAO FINAL ===');
        for (const [paymentId] of ITEMS) {
            const p = await Payment.findById(paymentId).select('paymentMethod splitMethods').lean();
            console.log(`Payment ${paymentId}: paymentMethod=${p.paymentMethod} splitMethods=${JSON.stringify(p.splitMethods)}`);
        }
        const agg = await Payment.findById(AGGREGATE_PAYMENT_ID).select('splitMethods').lean();
        console.log(`Aggregate ${AGGREGATE_PAYMENT_ID}: splitMethods=${JSON.stringify(agg.splitMethods)}`);
    }

    await mongoose.disconnect();
    console.log('\n[FIX] Concluido.');
}
run().catch(err => { console.error('[FIX] Erro:', err); process.exit(1); });
