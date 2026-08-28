#!/usr/bin/env node
/**
 * READ-ONLY: inspeciona o Payment 6a5e719dce43485b2af53897 (Isis Caldas Rebelatto)
 * e o Appointment vinculado, para confirmar onde está o splitMethods/paymentForms
 * com método "dinheiro" que deveria ser "cartão de crédito" (PIX 42 + Cartão 118).
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';

const PAYMENT_ID = '6a5e719dce43485b2af53897';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    await mongoose.connect(uri);
    console.log(`[INVESTIGATE] Conectado.\n`);

    const payment = await Payment.findById(PAYMENT_ID).lean();
    if (!payment) {
        console.log(`[INVESTIGATE] Payment ${PAYMENT_ID} não encontrado.`);
        await mongoose.disconnect();
        return;
    }

    console.log('=== PAYMENT ===');
    console.log('_id:', payment._id.toString());
    console.log('amount:', payment.amount);
    console.log('paymentMethod:', payment.paymentMethod);
    console.log('status:', payment.status);
    console.log('kind:', payment.kind);
    console.log('appointment:', payment.appointment?.toString() || null);
    console.log('splitMethods:', JSON.stringify(payment.splitMethods, null, 2));

    if (payment.appointment) {
        const appt = await Appointment.findById(payment.appointment).lean();
        if (appt) {
            console.log('\n=== APPOINTMENT VINCULADO ===');
            console.log('_id:', appt._id.toString());
            console.log('date/time:', appt.date, appt.time);
            console.log('paymentMethod:', appt.paymentMethod);
            console.log('paymentStatus:', appt.paymentStatus);
            console.log('paymentForms:', JSON.stringify(appt.paymentForms, null, 2));
        } else {
            console.log('\n[INVESTIGATE] Appointment vinculado não encontrado (id órfão?).');
        }
    }

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('[INVESTIGATE] Erro:', err);
    process.exit(1);
});
