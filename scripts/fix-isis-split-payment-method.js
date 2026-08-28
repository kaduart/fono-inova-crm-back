#!/usr/bin/env node
/**
 * FIX pontual: corrige o método de pagamento do split da Isis Caldas Rebelatto.
 * Pagamento real foi PIX R$42 + Cartão de Crédito R$118, mas ambos os registros
 * (Payment.splitMethods e Appointment.paymentForms) estavam gravados como "dinheiro"
 * para os R$118 — causa raiz: front-end enviava 'cartao_credito', mas o backend
 * (normalizePaymentMethod em payment.v2.js) não reconhecia esse valor e caía no
 * fallback 'cash'/'dinheiro' (bug corrigido separadamente no código).
 *
 * Payment:     6a5e719dce43485b2af53897 -> splitMethods._id 6a91db23840b39a658af1b83
 * Appointment: 6a5a7aebce43485b2af4e189 -> paymentForms._id 6a91db24840b39a658af1b95
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';

const PAYMENT_ID = '6a5e719dce43485b2af53897';
const PAYMENT_SPLIT_ENTRY_ID = '6a91db23840b39a658af1b83';
const APPOINTMENT_ID = '6a5a7aebce43485b2af4e189';
const APPOINTMENT_FORM_ENTRY_ID = '6a91db24840b39a658af1b95';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    await mongoose.connect(uri);
    console.log('[FIX] Conectado.\n');

    // --- Payment.splitMethods ---
    const paymentResult = await Payment.updateOne(
        { _id: PAYMENT_ID, 'splitMethods._id': PAYMENT_SPLIT_ENTRY_ID },
        { $set: { 'splitMethods.$.method': 'credit_card' } }
    );
    console.log('[FIX] Payment.splitMethods update:', JSON.stringify(paymentResult));

    // --- Appointment.paymentForms ---
    const apptResult = await Appointment.updateOne(
        { _id: APPOINTMENT_ID, 'paymentForms._id': APPOINTMENT_FORM_ENTRY_ID },
        { $set: { 'paymentForms.$.method': 'cartao_credito' } }
    );
    console.log('[FIX] Appointment.paymentForms update:', JSON.stringify(apptResult));

    // --- Verificação pós-fix ---
    const payment = await Payment.findById(PAYMENT_ID).lean();
    const appt = await Appointment.findById(APPOINTMENT_ID).lean();
    console.log('\n=== PAYMENT (depois) ===');
    console.log('splitMethods:', JSON.stringify(payment.splitMethods, null, 2));
    console.log('\n=== APPOINTMENT (depois) ===');
    console.log('paymentForms:', JSON.stringify(appt.paymentForms, null, 2));

    await mongoose.disconnect();
    console.log('\n[FIX] Concluído.');
}

run().catch(err => {
    console.error('[FIX] Erro:', err);
    process.exit(1);
});
