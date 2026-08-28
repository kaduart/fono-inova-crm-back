#!/usr/bin/env node
/**
 * READ-ONLY: investiga se o Payment 6a5e719dce43485b2af53897 faz parte de um
 * bulk-settle maior (mesmo splitGroupId ou mesmo timestamp de split), pra saber
 * o alcance real do bug de normalizePaymentMethod (cartao_credito -> dinheiro).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';

const PATIENT_NAME = 'Isis Caldas Rebelatto';
const KNOWN_PAYMENT_ID = '6a5e719dce43485b2af53897';
const SUSPECT_TIMESTAMP = '2026-08-28T19:01:55.454Z';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    await mongoose.connect(uri);
    console.log('[INVESTIGATE] Conectado.\n');

    const known = await Payment.findById(KNOWN_PAYMENT_ID).lean();
    console.log('splitGroupId do payment conhecido:', known.splitGroupId);

    const patient = await Patient.findOne({ fullName: PATIENT_NAME }).lean();
    if (!patient) { console.log('Paciente não encontrado'); await mongoose.disconnect(); return; }

    // 1. Mesmo splitGroupId
    if (known.splitGroupId) {
        const sameGroup = await Payment.find({ splitGroupId: known.splitGroupId }).lean();
        console.log(`\n=== Payments com mesmo splitGroupId (${known.splitGroupId}) ===`);
        console.log('Total:', sameGroup.length);
        sameGroup.forEach(p => {
            console.log(`  ${p._id} | amount=${p.amount} | paymentMethod=${p.paymentMethod} | splitMethods=${JSON.stringify(p.splitMethods)}`);
        });
    } else {
        console.log('\n[INVESTIGATE] Payment conhecido não tem splitGroupId.');
    }

    // 2. Todos os payments da Isis com splitMethods contendo o timestamp suspeito
    const allIsisPayments = await Payment.find({ patient: patient._id }).lean();
    console.log(`\n=== Todos os Payments da Isis: ${allIsisPayments.length} ===`);
    const suspects = allIsisPayments.filter(p =>
        (p.splitMethods || []).some(s => new Date(s.date).toISOString() === SUSPECT_TIMESTAMP)
    );
    console.log(`\n=== Payments com splitMethods datados de ${SUSPECT_TIMESTAMP}: ${suspects.length} ===`);
    suspects.forEach(p => {
        console.log(`  ${p._id} | amount=${p.amount} | paymentMethod=${p.paymentMethod} | splitGroupId=${p.splitGroupId} | splitMethods=${JSON.stringify(p.splitMethods)}`);
    });

    await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
