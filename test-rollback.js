#!/usr/bin/env node
/**
 * 🧪 TESTE DE ROLLBACK
 * 
 * Simula uma falha no meio do complete para garantir que:
 * - Não fica meio estado
 * - Appointment não é alterado se falhou
 * - Session não é criada se falhou
 * 
 * Uso: node test-rollback.js <appointmentId>
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from './models/Appointment.js';
import Session from './models/Session.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function testRollback(appointmentId) {
    console.log(`\n🧪 TESTE DE ROLLBACK: ${appointmentId}\n`);
    
    await mongoose.connect(MONGO_URI);
    
    // Estado inicial
    const beforeApt = await Appointment.findById(appointmentId).lean();
    if (!beforeApt) {
        console.log('❌ Appointment não encontrado');
        process.exit(1);
    }
    
    console.log('📊 ESTADO INICIAL:');
    console.log(`   clinicalStatus: ${beforeApt.clinicalStatus}`);
    console.log(`   operationalStatus: ${beforeApt.operationalStatus}`);
    console.log(`   has session: ${!!beforeApt.session}`);
    
    if (beforeApt.clinicalStatus === 'completed') {
        console.log('\n⚠️  Appointment já está completed. Escolha um que esteja scheduled.');
        await mongoose.disconnect();
        process.exit(1);
    }
    
    // Força um erro no meio do processo
    // Vamos interceptar a chamada e falhar
    console.log('\n💥 SIMULANDO FALHA NO MEIO DO PROCESSO...');
    
    const originalUpdateOne = Appointment.updateOne;
    let callCount = 0;
    
    // Mock que falha na segunda chamada
    Appointment.updateOne = function(...args) {
        callCount++;
        if (callCount >= 2) {
            console.log(`   💥 Forçando erro na chamada ${callCount}`);
            throw new Error('SIMULATED_FAILURE');
        }
        return originalUpdateOne.apply(this, args);
    };
    
    // Tenta completar (vai falhar)
    const { appointmentCompleteService } = await import('./services/appointmentCompleteService.js');
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.withTransaction(async () => {
            await appointmentCompleteService.complete(
                appointmentId,
                { userId: 'test_user' },
                mongoSession
            );
        });
        console.log('✅ Complete executou (não era pra ter falhado?)');
    } catch (err) {
        console.log(`   ❌ Erro capturado: ${err.message}`);
        console.log('   ✅ Rollback deve ter ocorrido');
    } finally {
        mongoSession.endSession();
        // Restaura mock
        Appointment.updateOne = originalUpdateOne;
    }
    
    // Verifica estado pós-falha
    console.log('\n📊 ESTADO APÓS FALHA:');
    const afterApt = await Appointment.findById(appointmentId).lean();
    
    console.log(`   clinicalStatus: ${afterApt.clinicalStatus}`);
    console.log(`   operationalStatus: ${afterApt.operationalStatus}`);
    console.log(`   has session: ${!!afterApt.session}`);
    
    // Validação
    console.log('\n' + '='.repeat(50));
    console.log('🔍 VALIDAÇÃO:');
    
    let errors = [];
    
    // Appointment deve estar igual ao inicial
    if (afterApt.clinicalStatus !== beforeApt.clinicalStatus) {
        errors.push(`❌ Appointment foi alterado mesmo com falha: ${beforeApt.clinicalStatus} → ${afterApt.clinicalStatus}`);
    } else {
        console.log('✅ Appointment não foi alterado (rollback funcionou)');
    }
    
    if (afterApt.session?.toString() !== beforeApt.session?.toString()) {
        errors.push('❌ Session foi criada mesmo com falha');
    } else {
        console.log('✅ Session não foi criada (rollback funcionou)');
    }
    
    console.log('\n' + '='.repeat(50));
    if (errors.length === 0) {
        console.log('✅ TESTE DE ROLLBACK PASSOU');
        console.log('   Transaction garante atomicidade');
    } else {
        console.log(`❌ ${errors.length} FALHA(S):`);
        errors.forEach(e => console.log(`   ${e}`));
    }
    
    await mongoose.disconnect();
    process.exit(errors.length > 0 ? 1 : 0);
}

const appointmentId = process.argv[2];
if (!appointmentId) {
    console.log('Uso: node test-rollback.js <appointmentId>');
    console.log('\n⚠️  ATENÇÃO: Use um appointment de TESTE em estado scheduled!');
    process.exit(1);
}

testRollback(appointmentId).catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
});
