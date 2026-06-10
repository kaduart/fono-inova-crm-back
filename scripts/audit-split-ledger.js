#!/usr/bin/env node
/**
 * 🔍 AUDIT SPLIT LEDGER
 * Script de validação para o novo modelo multi-payment.
 * Executar após deploy das mudanças de splitGroupId + paymentSyncHash.
 */

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';

async function audit() {
    await mongoose.connect(MONGO_URI);
    console.log('🔌 Conectado ao MongoDB');

    const issues = [];
    let ok = 0;

    // ============================================
    // 1. Verificar appointments sem paymentSyncHash
    // ============================================
    const withoutHash = await Appointment.countDocuments({
        paymentForms: { $exists: true, $ne: [] },
        paymentSyncHash: { $in: [null, ''] }
    });
    if (withoutHash > 0) {
        issues.push(`⚠️ ${withoutHash} appointment(s) com paymentForms mas SEM paymentSyncHash (precisam de backfill)`);
    }

    // ============================================
    // 2. Verificar payments duplicados por splitGroupId
    // ============================================
    const dupSplits = await Payment.aggregate([
        { $match: { splitGroupId: { $ne: null }, status: { $nin: ['canceled', 'cancelado'] } } },
        { $group: { _id: '$splitGroupId', count: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } }
    ]);
    if (dupSplits.length > 0) {
        issues.push(`⚠️ ${dupSplits.length} splitGroupId(s) com payments duplicados (esperado: N payments por split, mas verificar se não é bug)`);
        for (const d of dupSplits.slice(0, 5)) {
            issues.push(`    - ${d._id}: ${d.count} payments`);
        }
    }

    // ============================================
    // 3. Verificar divergência: paymentForms total vs Payments total por appointment
    // ============================================
    const appointmentsWithForms = await Appointment.find({
        paymentForms: { $exists: true, $ne: [] },
        operationalStatus: 'completed'
    }).select('_id paymentForms patientName').lean();

    for (const appt of appointmentsWithForms) {
        const formsTotal = (appt.paymentForms || []).reduce((s, f) => s + (f.amount || 0), 0);
        const payments = await Payment.find({
            appointment: appt._id,
            status: { $nin: ['canceled', 'cancelado'] }
        }).select('amount').lean();
        const paymentsTotal = payments.reduce((s, p) => s + p.amount, 0);

        if (Math.abs(formsTotal - paymentsTotal) > 0.01) {
            issues.push(`❌ Divergência: appointment ${appt._id} | paymentForms=${formsTotal} | Payments=${paymentsTotal}`);
        } else {
            ok++;
        }
    }

    // ============================================
    // 4. Verificar se 1 appointment tem N splitGroups (anomalia)
    // ============================================
    const multiSplitGroups = await Payment.aggregate([
        { $match: { splitGroupId: { $ne: null }, status: { $nin: ['canceled', 'cancelado'] } } },
        { $group: { _id: '$appointment', groups: { $addToSet: '$splitGroupId' } } },
        { $match: { $expr: { $gt: [{ $size: '$groups' }, 1] } } }
    ]);
    if (multiSplitGroups.length > 0) {
        issues.push(`⚠️ ${multiSplitGroups.length} appointment(s) com múltiplos splitGroupId ativos (pode indicar reprocessamento)`);
    }

    // ============================================
    // 5. Relatório final
    // ============================================
    console.log('\n========================================');
    console.log('📊 AUDIT SPLIT LEDGER — RESULTADO');
    console.log('========================================');
    console.log(`Appointments verificados: ${appointmentsWithForms.length}`);
    console.log(`Appointments consistentes:  ${ok}`);
    console.log(`Problemas encontrados:      ${issues.length}`);
    console.log('----------------------------------------');
    if (issues.length === 0) {
        console.log('✅ Ledger está consistente');
    } else {
        for (const issue of issues) {
            console.log(issue);
        }
    }
    console.log('========================================\n');

    await mongoose.disconnect();
}

audit().catch(err => {
    console.error('💥 Erro no audit:', err.message);
    process.exit(1);
});
