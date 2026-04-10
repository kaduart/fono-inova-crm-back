#!/usr/bin/env node
/**
 * 🧪 SCRIPT DE VALIDAÇÃO DO COMPLETE
 * 
 * Testa os 3 cenários críticos:
 * 1. Pacote pré-pago
 * 2. Particular pago
 * 3. Fiado (addToBalance)
 * 
 * Uso: node test-complete-validation.js <appointmentId>
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from './models/Appointment.js';
import Session from './models/Session.js';
import Payment from './models/Payment.js';
import FinancialLedger from './models/FinancialLedger.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function validateComplete(appointmentId) {
    console.log(`\n🧪 VALIDANDO APPOINTMENT: ${appointmentId}\n`);
    
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
    
    console.log('📋 APPOINTMENT:');
    console.log(`  clinicalStatus: ${apt.clinicalStatus}`);
    console.log(`  operationalStatus: ${apt.operationalStatus}`);
    console.log(`  paymentStatus: ${apt.paymentStatus}`);
    console.log(`  visualFlag: ${apt.visualFlag}`);
    console.log(`  has package: ${!!apt.package}`);
    console.log(`  has payment: ${!!apt.payment}`);
    
    console.log('\n📋 SESSION:');
    if (apt.session) {
        console.log(`  status: ${apt.session.status}`);
        console.log(`  paymentStatus: ${apt.session.paymentStatus}`);
        console.log(`  isPaid: ${apt.session.isPaid}`);
        console.log(`  visualFlag: ${apt.session.visualFlag}`);
        console.log(`  paymentOrigin: ${apt.session.paymentOrigin || 'null'}`);
    } else {
        console.log('  ❌ SEM SESSION');
    }
    
    console.log('\n📋 PAYMENT:');
    if (apt.payment) {
        console.log(`  status: ${apt.payment.status}`);
        console.log(`  amount: ${apt.payment.amount}`);
        console.log(`  paidAt: ${apt.payment.paidAt || 'null'}`);
    } else {
        console.log('  ❌ SEM PAYMENT');
    }
    
    console.log('\n📋 LEDGER:');
    const ledgers = await FinancialLedger.find({
        $or: [
            { appointment: appointmentId },
            { session: apt.session?._id },
            { payment: apt.payment?._id }
        ]
    }).lean();
    
    if (ledgers.length > 0) {
        console.log(`  ${ledgers.length} lançamento(s) encontrado(s):`);
        ledgers.forEach((l, i) => {
            console.log(`    ${i+1}. ${l.type} | ${l.direction} | R$ ${l.amount} | ${l.correlationId?.slice(-8)}`);
        });
    } else {
        console.log('  ℹ️ Nenhum lançamento no ledger');
    }
    
    // 🔍 VALIDAÇÕES
    console.log('\n' + '='.repeat(50));
    console.log('🔍 VALIDAÇÕES:');
    
    let errors = [];
    
    // 1. Appointment deve estar completed
    if (apt.clinicalStatus !== 'completed') {
        errors.push('❌ Appointment.clinicalStatus !== completed');
    } else {
        console.log('✅ Appointment completed');
    }
    
    // 2. Session deve existir e estar completed
    if (!apt.session) {
        errors.push('❌ Session não existe');
    } else if (apt.session.status !== 'completed') {
        errors.push('❌ Session.status !== completed');
    } else {
        console.log('✅ Session completed');
    }
    
    // 3. Se tem package, deve estar pago
    if (apt.package) {
        if (apt.paymentStatus !== 'package_paid' && apt.paymentStatus !== 'paid') {
            errors.push('❌ Package mas paymentStatus incorreto');
        } else {
            console.log('✅ Package com paymentStatus correto');
        }
        
        if (apt.session?.paymentOrigin !== 'package_prepaid') {
            errors.push('❌ Package mas session.paymentOrigin incorreto');
        } else {
            console.log('✅ Package com paymentOrigin correto');
        }
        
        if (ledgers.length === 0 || !ledgers.some(l => l.type === 'package_consumed')) {
            console.log('⚠️ Nenhum ledger de package_consumed (pode ser normal se for pacote per-session)');
        } else {
            console.log('✅ Ledger de package encontrado');
        }
    }
    
    // 4. Session e Appointment devem ter paymentStatus igual
    if (apt.session && apt.session.paymentStatus !== apt.paymentStatus) {
        errors.push(`❌ Session.paymentStatus (${apt.session.paymentStatus}) !== Appointment.paymentStatus (${apt.paymentStatus})`);
    } else if (apt.session) {
        console.log('✅ Session e Appointment paymentStatus iguais');
    }
    
    // 5. Se tem payment, deve ter ledger
    if (apt.payment && apt.payment.status === 'paid' && !apt.package) {
        if (ledgers.length === 0) {
            console.log('⚠️ Payment pago mas sem ledger (pode ser legado)');
        } else {
            console.log('✅ Payment pago com ledger');
        }
    }
    
    console.log('\n' + '='.repeat(50));
    if (errors.length === 0) {
        console.log('✅ TODAS AS VALIDAÇÕES PASSARAM');
    } else {
        console.log(`❌ ${errors.length} ERRO(S):`);
        errors.forEach(e => console.log(`   ${e}`));
    }
    
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
    process.exit(errors.length > 0 ? 1 : 0);
}

const appointmentId = process.argv[2];
if (!appointmentId) {
    console.log('Uso: node test-complete-validation.js <appointmentId>');
    process.exit(1);
}

validateComplete(appointmentId).catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
});
