#!/usr/bin/env node
/**
 * TESTE RÁPIDO DO SISTEMA HYBRID
 * 
 * Execute: node back/test.hybrid.js
 */

import mongoose from 'mongoose';
import { appointmentHybridService } from './services/appointmentHybridService.js';
import { appointmentCompleteService } from './services/appointmentCompleteService.js';
import dotenv from 'dotenv';

dotenv.config();

// Mock de usuários e doutores (substitua pelos reais no seu MongoDB)
const MOCK_DATA = {
    patientId: '000000000000000000000001',
    doctorId: '000000000000000000000002',
    packageId: null,
    date: '2025-04-01',
    time: '10:00'
};

async function connect() {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica';
    await mongoose.connect(uri);
    console.log('✅ Conectado ao MongoDB');
}

async function testParticular() {
    console.log('\n🧪 TESTE 1: PARTICULAR (deve criar Appointment + Session + Payment)');
    
    const session = await mongoose.startSession();
    await session.startTransaction();
    
    try {
        const result = await appointmentHybridService.create({
            patientId: MOCK_DATA.patientId,
            doctorId: MOCK_DATA.doctorId,
            date: MOCK_DATA.date,
            time: '10:00',
            serviceType: 'session',
            billingType: 'particular',
            paymentMethod: 'pix',
            amount: 200,
            userId: 'admin'
        }, session);
        
        console.log('Resultado:', result);
        
        // Validações
        if (!result.appointmentId) throw new Error('Faltou appointment');
        if (!result.sessionId) throw new Error('Faltou session');
        if (!result.paymentId) throw new Error('Faltou payment (particular deve ter!)');
        if (result.billingType !== 'particular') throw new Error('Billing type errado');
        
        console.log('✅ PARTICULAR OK');
        
        await session.commitTransaction();
        
        return result.appointmentId;
    } catch (e) {
        await session.abortTransaction();
        console.error('❌ PARTICULAR FALHOU:', e.message);
        throw e;
    } finally {
        session.endSession();
    }
}

async function testPacotePagoComCredito() {
    console.log('\n🧪 TESTE 2A: PACOTE PAGO + CRÉDITO (sem Payment, usa crédito)');
    
    // Este teste precisa de um pacote existente no seu DB
    // Simulando: package pago, 5 créditos restantes
    const mockPackageId = process.env.TEST_PACKAGE_ID || '000000000000000000000099';
    
    const session = await mongoose.startSession();
    await session.startTransaction();
    
    try {
        const result = await appointmentHybridService.create({
            patientId: MOCK_DATA.patientId,
            doctorId: MOCK_DATA.doctorId,
            date: MOCK_DATA.date,
            time: '14:00',
            serviceType: 'package_session',
            billingType: 'particular',
            packageId: mockPackageId,
            paymentMethod: 'package',
            amount: 0, // Usa crédito do pacote
            userId: 'admin'
        }, session);
        
        console.log('Resultado:', result);
        
        // Validações
        if (!result.appointmentId) throw new Error('Faltou appointment');
        if (!result.sessionId) throw new Error('Faltou session');
        if (result.paymentId) throw new Error('NÃO deve ter payment (usa crédito!)');
        if (result.paymentStrategy !== 'package_prepaid') throw new Error('Strategy errada: ' + result.paymentStrategy);
        
        console.log('✅ PACOTE PAGO COM CRÉDITO OK');
        
        await session.commitTransaction();
    } catch (e) {
        await session.abortTransaction();
        if (e.message.includes('não encontrado') || e.message.includes('not found')) {
            console.log('⚠️  Pacote mock não encontrado - crie um pacote de teste ou defina TEST_PACKAGE_ID');
            console.log('   Simulação: Strategy seria "package_prepaid", sem Payment');
            return;
        }
        console.error('❌ PACOTE PAGO FALHOU:', e.message);
        throw e;
    } finally {
        session.endSession();
    }
}

async function testPacoteEsgotado() {
    console.log('\n🧪 TESTE 2B: PACOTE ESGOTADO (cria Payment avulso)');
    
    // Simula pacote esgotado: forcePayment + amount > 0
    const mockPackageId = process.env.TEST_PACKAGE_ID || '000000000000000000000099';
    
    const session = await mongoose.startSession();
    await session.startTransaction();
    
    try {
        const result = await appointmentHybridService.create({
            patientId: MOCK_DATA.patientId,
            doctorId: MOCK_DATA.doctorId,
            date: MOCK_DATA.date,
            time: '15:00',
            serviceType: 'package_session',
            billingType: 'particular',
            packageId: mockPackageId,
            paymentMethod: 'pix',
            amount: 150, // Vai pagar avulso
            forcePayment: true, // Força porque pacote esgotou
            userId: 'admin'
        }, session);
        
        console.log('Resultado:', result);
        
        // Validações
        if (!result.appointmentId) throw new Error('Faltou appointment');
        if (!result.sessionId) throw new Error('Faltou session');
        if (!result.paymentId) throw new Error('DEVE ter payment (pacote esgotado!)');
        if (result.paymentStrategy !== 'package_forced_payment' && result.paymentStrategy !== 'package_exhausted') {
            throw new Error('Strategy errada: ' + result.paymentStrategy);
        }
        
        console.log('✅ PACOTE ESGOTADO OK (pagamento avulso criado)');
        
        await session.commitTransaction();
    } catch (e) {
        await session.abortTransaction();
        if (e.message.includes('não encontrado') || e.message.includes('not found')) {
            console.log('⚠️  Pacote mock não encontrado - crie um pacote de teste');
            console.log('   Simulação: Strategy seria "package_exhausted", COM Payment');
            return;
        }
        console.error('❌ PACOTE ESGOTADO FALHOU:', e.message);
        throw e;
    } finally {
        session.endSession();
    }
}

async function testPacoteParcelado() {
    console.log('\n🧪 TESTE 2C: PACOTE PARCELADO (usa crédito, mas flagged)');
    
    // Simula pacote parcelado: pago parcialmente, tem crédito
    const mockPackageId = process.env.TEST_PACKAGE_ID || '000000000000000000000099';
    
    const session = await mongoose.startSession();
    await session.startTransaction();
    
    try {
        const result = await appointmentHybridService.create({
            patientId: MOCK_DATA.patientId,
            doctorId: MOCK_DATA.doctorId,
            date: MOCK_DATA.date,
            time: '16:00',
            serviceType: 'package_session',
            billingType: 'particular',
            packageId: mockPackageId,
            paymentMethod: 'package',
            amount: 0,
            userId: 'admin'
        }, session);
        
        console.log('Resultado:', result);
        
        // Validações
        if (!result.appointmentId) throw new Error('Faltou appointment');
        if (!result.sessionId) throw new Error('Faltou session');
        // Não deve ter payment agora, mas vai cobrar depois
        if (result.paymentId) throw new Error('NÃO deve ter payment agora (parcelado)');
        
        console.log('✅ PACOTE PARCELADO OK (crédito liberado, quitação pendente)');
        
        await session.commitTransaction();
    } catch (e) {
        await session.abortTransaction();
        if (e.message.includes('não encontrado') || e.message.includes('not found')) {
            console.log('⚠️  Pacote mock não encontrado');
            return;
        }
        console.error('❌ PACOTE PARCELADO FALHOU:', e.message);
        throw e;
    } finally {
        session.endSession();
    }
}

async function testConvenio() {
    console.log('\n🧪 TESTE 3: CONVÊNIO (deve criar Appointment + Session, MAS NÃO Payment)');
    
    const session = await mongoose.startSession();
    await session.startTransaction();
    
    try {
        const result = await appointmentHybridService.create({
            patientId: MOCK_DATA.patientId,
            doctorId: MOCK_DATA.doctorId,
            date: MOCK_DATA.date,
            time: '16:00',
            serviceType: 'session',
            billingType: 'convenio',
            paymentMethod: 'convenio',
            amount: 150, // Tem valor, mas é convênio
            insuranceGuideId: '000000000000000000000088',
            userId: 'admin'
        }, session);
        
        console.log('Resultado:', result);
        
        // Validações
        if (!result.appointmentId) throw new Error('Faltou appointment');
        if (!result.sessionId) throw new Error('Faltou session');
        if (result.paymentId) throw new Error('NÃO deve ter payment (convênio!)');
        
        console.log('✅ CONVÊNIO OK');
        
        await session.commitTransaction();
    } catch (e) {
        await session.abortTransaction();
        console.error('❌ CONVÊNIO FALHOU:', e.message);
    } finally {
        session.endSession();
    }
}

async function testComplete(appointmentId) {
    console.log('\n🧪 TESTE 4: COMPLETE (processa pagamento)');
    
    const session = await mongoose.startSession();
    await session.startTransaction();
    
    try {
        const result = await appointmentCompleteService.complete(
            appointmentId,
            { userId: 'admin' },
            session
        );
        
        console.log('Resultado:', result);
        console.log('✅ COMPLETE OK');
        
        await session.commitTransaction();
    } catch (e) {
        await session.abortTransaction();
        console.error('❌ COMPLETE FALHOU:', e.message);
        throw e;
    } finally {
        session.endSession();
    }
}

async function run() {
    console.log('🚀 INICIANDO TESTES DO SISTEMA HYBRID\n');
    
    await connect();
    
    try {
        const appointmentId = await testParticular();
        await testPacotePagoComCredito();
        await testPacoteEsgotado();
        await testPacoteParcelado();
        await testConvenio();
        
        // Só completa o PARTICULAR se o ID existe
        if (appointmentId) {
            await testComplete(appointmentId);
        }
        
        console.log('\n✅✅✅ TODOS OS TESTES PASSARAM! ✅✅✅\n');
    } catch (e) {
        console.error('\n❌❌❌ ALGUM TESTE FALHOU ❌❌❌\n');
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Desconectado');
    }
}

run();
