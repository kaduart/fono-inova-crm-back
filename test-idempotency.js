#!/usr/bin/env node
/**
 * 🧪 TESTE DE IDEMPOTÊNCIA E DUPLICAÇÃO
 * 
 * Executa o complete 2x no mesmo appointment para garantir que:
 * - Não cria 2 sessions
 * - Não cria 2 payments
 * - Não cria 2 ledgers
 * 
 * Uso: node test-idempotency.js <appointmentId>
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from './models/Appointment.js';
import Session from './models/Session.js';
import Payment from './models/Payment.js';
import FinancialLedger from './models/FinancialLedger.js';
import { appointmentCompleteService } from './services/appointmentCompleteService.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function testIdempotency(appointmentId) {
    console.log(`\n🧪 TESTE DE IDEMPOTÊNCIA: ${appointmentId}\n`);
    
    await mongoose.connect(MONGO_URI);
    
    // Contagem inicial
    const initialCounts = await getCounts(appointmentId);
    console.log('📊 CONTAGEM INICIAL:');
    printCounts(initialCounts);
    
    // PRIMEIRA EXECUÇÃO
    console.log('\n🔄 PRIMEIRA EXECUÇÃO...');
    const mongoSession1 = await mongoose.startSession();
    let result1;
    try {
        await mongoSession1.withTransaction(async () => {
            result1 = await appointmentCompleteService.complete(
                appointmentId,
                { userId: 'test_user' },
                mongoSession1
            );
        });
        console.log('✅ Resultado:', result1.status);
    } catch (err) {
        console.log('❌ Erro:', err.message);
    } finally {
        mongoSession1.endSession();
    }
    
    const afterFirst = await getCounts(appointmentId);
    console.log('\n📊 APÓS PRIMEIRA:');
    printCounts(afterFirst);
    
    // SEGUNDA EXECUÇÃO (idempotência)
    console.log('\n🔄 SEGUNDA EXECUÇÃO (idempotência)...');
    const mongoSession2 = await mongoose.startSession();
    let result2;
    try {
        await mongoSession2.withTransaction(async () => {
            result2 = await appointmentCompleteService.complete(
                appointmentId,
                { userId: 'test_user' },
                mongoSession2
            );
        });
        console.log('✅ Resultado:', result2.status);
    } catch (err) {
        console.log('❌ Erro:', err.message);
    } finally {
        mongoSession2.endSession();
    }
    
    const afterSecond = await getCounts(appointmentId);
    console.log('\n📊 APÓS SEGUNDA:');
    printCounts(afterSecond);
    
    // VALIDAÇÃO
    console.log('\n' + '='.repeat(50));
    console.log('🔍 VALIDAÇÃO:');
    
    let errors = [];
    
    // Sessions não devem ter aumentado na segunda execução
    if (afterSecond.sessions > afterFirst.sessions) {
        errors.push('❌ DUPLICAÇÃO: Session criada na segunda execução');
    } else {
        console.log('✅ Nenhuma session duplicada');
    }
    
    // Payments não devem ter aumentado na segunda execução
    if (afterSecond.payments > afterFirst.payments) {
        errors.push('❌ DUPLICAÇÃO: Payment criado na segunda execução');
    } else {
        console.log('✅ Nenhum payment duplicado');
    }
    
    // Ledgers não devem ter aumentado na segunda execução
    if (afterSecond.ledgers > afterFirst.ledgers) {
        errors.push('❌ DUPLICAÇÃO: Ledger criado na segunda execução');
    } else {
        console.log('✅ Nenhum ledger duplicado');
    }
    
    // Resultado da segunda deve ser idempotente
    if (result2?.status === 'already_completed') {
        console.log('✅ Segunda execução retornou idempotente (already_completed)');
    } else if (result1?.status === 'already_completed') {
        console.log('ℹ️ Primeira já estava completed');
    } else {
        console.log('⚠️ Segunda execução não retornou already_completed (pode ser OK se primeira falhou)');
    }
    
    console.log('\n' + '='.repeat(50));
    if (errors.length === 0) {
        console.log('✅ TESTE DE IDEMPOTÊNCIA PASSOU');
        console.log('   Sistema não duplica dados em retry');
    } else {
        console.log(`❌ ${errors.length} FALHA(S):`);
        errors.forEach(e => console.log(`   ${e}`));
    }
    
    await mongoose.disconnect();
    process.exit(errors.length > 0 ? 1 : 0);
}

async function getCounts(appointmentId) {
    const apt = await Appointment.findById(appointmentId).lean();
    
    const sessions = apt?.session 
        ? await Session.countDocuments({ appointmentId })
        : 0;
    
    const payments = apt?.payment
        ? await Payment.countDocuments({ appointment: appointmentId })
        : 0;
    
    const ledgers = await FinancialLedger.countDocuments({
        $or: [
            { appointment: appointmentId },
            { session: apt?.session }
        ]
    });
    
    return { sessions, payments, ledgers };
}

function printCounts(counts) {
    console.log(`   Sessions: ${counts.sessions}`);
    console.log(`   Payments: ${counts.payments}`);
    console.log(`   Ledgers: ${counts.ledgers}`);
}

const appointmentId = process.argv[2];
if (!appointmentId) {
    console.log('Uso: node test-idempotency.js <appointmentId>');
    console.log('\n⚠️  ATENÇÃO: Use um appointment de TESTE, não de produção!');
    process.exit(1);
}

testIdempotency(appointmentId).catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
});
