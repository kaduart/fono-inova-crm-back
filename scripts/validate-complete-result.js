#!/usr/bin/env node
/**
 * 🔍 Valida resultado de um PATCH /:id/complete
 * 
 * Uso: node scripts/validate-complete-result.js <appointmentId>
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import FinancialLedger from '../models/FinancialLedger.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function validate(appointmentId) {
    console.log(`🔍 Validando complete do appointment: ${appointmentId}\n`);
    
    await mongoose.connect(MONGO_URI);
    
    const apt = await Appointment.findById(appointmentId)
        .populate('session')
        .populate('package')
        .populate('payment')
        .lean();
    
    if (!apt) {
        console.log('❌ Appointment não encontrado');
        process.exit(1);
    }

    const sessionId = apt.session?._id?.toString();
    const packageId = apt.package?._id?.toString();
    const paymentId = apt.payment?._id?.toString() || apt.payment;

    // Buscar dados atualizados
    const session = sessionId ? await Session.findById(sessionId).lean() : null;
    const pkg = packageId ? await Package.findById(packageId).lean() : null;
    const payment = paymentId ? await Payment.findById(paymentId).lean() : null;
    
    // Buscar ledger entries
    const ledgerEntries = await FinancialLedger.find({
        $or: [
            { appointment: appointmentId },
            { session: sessionId },
            { payment: paymentId }
        ]
    }).sort({ occurredAt: -1 }).lean();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 APPOINTMENT');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  _id:              ${apt._id}`);
    console.log(`  operationalStatus: ${apt.operationalStatus} ${apt.operationalStatus === 'completed' ? '✅' : '❌'}`);
    console.log(`  clinicalStatus:    ${apt.clinicalStatus} ${apt.clinicalStatus === 'completed' ? '✅' : '❌'}`);
    console.log(`  paymentStatus:     ${apt.paymentStatus || '—'}`);
    console.log(`  billingType:       ${apt.billingType || '—'}`);
    console.log(`  sessionValue:      ${apt.sessionValue || 0}`);
    console.log(`  balanceAmount:     ${apt.balanceAmount || 0}`);
    console.log(`  completedAt:       ${apt.completedAt || '—'}`);
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎬 SESSION');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (session) {
        console.log(`  _id:          ${session._id}`);
        console.log(`  status:       ${session.status} ${session.status === 'completed' ? '✅' : '❌'}`);
        console.log(`  isPaid:       ${session.isPaid}`);
        console.log(`  paymentStatus:${session.paymentStatus || '—'}`);
        console.log(`  paymentOrigin:${session.paymentOrigin || '—'}`);
        console.log(`  completedAt:  ${session.completedAt || '—'}`);
    } else {
        console.log('  ⚠️ Sem session vinculada');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 PACKAGE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (pkg) {
        console.log(`  _id:          ${pkg._id}`);
        console.log(`  status:       ${pkg.status}`);
        console.log(`  sessionsDone: ${pkg.sessionsDone || 0}`);
        console.log(`  totalSessions:${pkg.totalSessions || 0}`);
        console.log(`  totalPaid:    ${pkg.totalPaid || 0}`);
        console.log(`  balance:      ${pkg.balance || 0}`);
        console.log(`  financialStatus:${pkg.financialStatus || '—'}`);
    } else {
        console.log('  ℹ️ Sem package vinculado');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💰 PAYMENT');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (payment) {
        console.log(`  _id:          ${payment._id}`);
        console.log(`  status:       ${payment.status}`);
        console.log(`  amount:       ${payment.amount}`);
        console.log(`  billingType:  ${payment.billingType || '—'}`);
        console.log(`  paymentMethod:${payment.paymentMethod || '—'}`);
        console.log(`  kind:         ${payment.kind || '—'}`);
        console.log(`  isFromPackage:${payment.isFromPackage}`);
        console.log(`  financialDate:${payment.financialDate || '—'}`);
    } else {
        console.log('  ⚠️ Sem payment vinculado');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🏦 LEDGER ENTRIES');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (ledgerEntries.length) {
        ledgerEntries.forEach(e => {
            console.log(`  [${e.type}] ${e.amount} — ${e.description?.substring(0, 50) || '—'}`);
        });
    } else {
        console.log('  ⚠️ Nenhuma entrada no ledger');
    }

    // Resumo
    const allGood = apt.operationalStatus === 'completed' && 
                    apt.clinicalStatus === 'completed' &&
                    (!session || session.status === 'completed');

    console.log('\n' + '═'.repeat(50));
    if (allGood) {
        console.log('✅ COMPLETE PARECE TER SIDO BEM-SUCEDIDO');
    } else {
        console.log('❌ ALGO PARECE ERRADO — VERIFIQUE OS ITENS ACIMA');
    }
    console.log('═'.repeat(50));

    await mongoose.disconnect();
}

const id = process.argv[2];
if (!id) {
    console.log('Uso: node scripts/validate-complete-result.js <appointmentId>');
    process.exit(1);
}

validate(id).catch(err => {
    console.error('Erro:', err.message);
    process.exit(1);
});
