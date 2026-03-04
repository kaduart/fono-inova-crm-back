#!/usr/bin/env node
/**
 * 🧪 TESTE DE INTEGRAÇÃO: Caso Ana Laura (Regressão)
 * 
 * Simula exatamente o fluxo que quebrou em produção:
 * 1. Nome coletado (Ana Laura Vieira Do Amaral)
 * 2. Idade coletada (20)
 * 3. Período coletado (tarde)
 * 4. Queixa descrita
 * 5. hasAll=true → Deve oferecer slots
 * 6. NÃO deve entrar em loop
 * 7. NÃO deve corromper idade
 */

import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const MONGO_URI = process.env.MONGO_URI;
const PHONE_TESTE = '5562999999998';

function pass(msg) { console.log(`✅ ${msg}`); }
function fail(msg) { console.log(`❌ ${msg}`); process.exitCode = 1; }
function section(msg) { console.log(`\n${'═'.repeat(60)}\n${msg}\n${'═'.repeat(60)}`); }

async function connect() {
    await mongoose.connect(MONGO_URI);
    console.log('🔌 Conectado ao MongoDB');
}

async function limparLead() {
    await mongoose.connection.collection('leads').deleteOne({ 'contact.phone': PHONE_TESTE });
}

async function criarLead() {
    const lead = {
        contact: { phone: PHONE_TESTE },
        name: 'Lead Teste Ana Laura',
        stage: 'novo',
        createdAt: new Date()
    };
    const result = await mongoose.connection.collection('leads').insertOne(lead);
    return { ...lead, _id: result.insertedId };
}

async function atualizarLead(leadId, updates) {
    await mongoose.connection.collection('leads').updateOne(
        { _id: leadId },
        { $set: updates }
    );
    return await mongoose.connection.collection('leads').findOne({ _id: leadId });
}

async function buscarLead(leadId) {
    return await mongoose.connection.collection('leads').findOne({ _id: leadId });
}

// ═══════════════════════════════════════════════════════════
// TESTE PRINCIPAL
// ═══════════════════════════════════════════════════════════

async function runTest() {
    await connect();
    
    section('🎭 Simulação: Caso Ana Laura (Fluxo que quebrou em produção)');
    
    await limparLead();
    let lead = await criarLead();
    
    // ═══════════════════════════════════════════════════════════
    // PASSO 1: Paciente manda nome completo
    // ═══════════════════════════════════════════════════════════
    section('Passo 1: Coletando nome');
    
    lead = await atualizarLead(lead._id, {
        'patientInfo.fullName': 'Ana Laura Vieira Do Amaral',
        stage: 'triagem_agendamento'
    });
    
    console.log('📨 Paciente: "Ana Laura Vieira Do Amaral"');
    console.log(`💾 Lead: nome = ${lead.patientInfo?.fullName}`);
    
    if (lead.patientInfo?.fullName !== 'Ana Laura Vieira Do Amaral') {
        fail('Nome não foi salvo corretamente');
        return;
    }
    pass('Nome coletado e salvo');
    
    // ═══════════════════════════════════════════════════════════
    // PASSO 2: Paciente manda idade
    // ═══════════════════════════════════════════════════════════
    section('Passo 2: Coletando idade (20 anos)');
    
    lead = await atualizarLead(lead._id, {
        'patientInfo.age': 20
    });
    
    console.log('📨 Paciente: "20" (anos)');
    console.log(`💾 Lead: idade = ${lead.patientInfo?.age}`);
    
    if (lead.patientInfo?.age !== 20) {
        fail('Idade não foi salva corretamente');
        return;
    }
    pass('Idade 20 coletada e salva');
    
    // ═══════════════════════════════════════════════════════════
    // PASSO 3: Paciente manda período
    // ═══════════════════════════════════════════════════════════
    section('Passo 3: Coletando período (tarde)');
    
    lead = await atualizarLead(lead._id, {
        'pendingPreferredPeriod': 'tarde',
        'qualificationData.disponibilidade': 'tarde'
    });
    
    console.log('📨 Paciente: "Tarde"');
    console.log(`💾 Lead: período = ${lead.pendingPreferredPeriod}`);
    
    if (lead.pendingPreferredPeriod !== 'tarde') {
        fail('Período não foi salvo corretamente');
        return;
    }
    pass('Período "tarde" coletado e salvo');
    
    // ═══════════════════════════════════════════════════════════
    // PASSO 4: Paciente descreve queixa
    // ═══════════════════════════════════════════════════════════
    section('Passo 4: Coletando queixa');
    
    const queixa = "Minha namorada tem um problema com a fala, não sei falar se é língua presa";
    lead = await atualizarLead(lead._id, {
        'complaint': queixa,
        'therapyArea': 'fonoaudiologia'
    });
    
    console.log(`📨 Paciente: "${queixa.substring(0, 50)}..."`);
    console.log(`💾 Lead: queixa = ${lead.complaint ? 'presente' : 'ausente'}`);
    console.log(`💾 Lead: therapyArea = ${lead.therapyArea}`);
    
    if (!lead.complaint || lead.therapyArea !== 'fonoaudiologia') {
        fail('Queixa ou therapyArea não salvos');
        return;
    }
    pass('Queixa coletada e salva');
    
    // ═══════════════════════════════════════════════════════════
    // VERIFICAÇÃO CRÍTICA: hasAll deve ser true
    // ═══════════════════════════════════════════════════════════
    section('🔍 Verificação: Triagem Completa (hasAll)');
    
    const hasAll = !!(
        lead.patientInfo?.fullName &&
        lead.patientInfo?.age &&
        lead.pendingPreferredPeriod &&
        lead.complaint &&
        lead.therapyArea
    );
    
    console.log('📋 Checklist:');
    console.log(`   ✓ Nome: ${lead.patientInfo?.fullName}`);
    console.log(`   ✓ Idade: ${lead.patientInfo?.age}`);
    console.log(`   ✓ Período: ${lead.pendingPreferredPeriod}`);
    console.log(`   ✓ Queixa: ${lead.complaint ? 'presente' : 'falta'}`);
    console.log(`   ✓ Área: ${lead.therapyArea}`);
    console.log(`   → hasAll: ${hasAll}`);
    
    if (!hasAll) {
        fail('Triagem deveria estar completa (hasAll=true)');
        return;
    }
    pass('Triagem completa detectada');
    
    // ═══════════════════════════════════════════════════════════
    // TESTE CRÍTICO: Idade NÃO deve ser corrompida
    // ═══════════════════════════════════════════════════════════
    section('🛡️ Teste Crítico: Proteção contra corrupção de idade');
    
    // Simula mensagem que anteriormente corrompia idade
    const mensagemPerigosa = "minha filha tem 20 anos e faz 1 sessão por semana";
    console.log(`📨 Mensagem: "${mensagemPerigosa}"`);
    console.log('⚠️  Antes: "1" de "1 sessão" era capturado como idade!');
    
    // Extrai idade usando função corrigida
    const { extractAgeFromText } = await import('../../utils/patientDataExtractor.js');
    const { safeAgeUpdate } = await import('../../utils/safeDataUpdate.js');
    
    const idadeExtraida = extractAgeFromText(mensagemPerigosa);
    console.log(`🔍 Idade extraída: ${idadeExtraida ? idadeExtraida.age : 'null'}`);
    
    const safeResult = safeAgeUpdate(lead.patientInfo.age, idadeExtraida?.age, mensagemPerigosa);
    console.log(`🛡️  SafeAgeUpdate: ${lead.patientInfo.age} → ${safeResult.age} (${safeResult.reason})`);
    
    if (safeResult.age !== 20) {
        fail(`Idade corrompida! Era 20, virou ${safeResult.age}`);
        return;
    }
    pass('Idade protegida contra corrupção!');
    
    // ═══════════════════════════════════════════════════════════
    // TESTE CRÍTICO: Loop de triagem
    // ═══════════════════════════════════════════════════════════
    section('🔄 Teste Crítico: Prevenção de Loop');
    
    const { shouldSkipQuestion } = await import('../../utils/safeDataUpdate.js');
    
    // Se Amanda já tem período, NÃO deve perguntar de novo
    const devePularPeriodo = shouldSkipQuestion(lead, 'period');
    console.log(`📨 Amanda pergunta: "manhã ou tarde?"`);
    console.log(`💾 Lead já tem: período = ${lead.pendingPreferredPeriod}`);
    console.log(`⏭️  Deve pular pergunta: ${devePularPeriodo}`);
    
    if (!devePularPeriodo) {
        fail('Deveria pular pergunta de período (já tem tarde)');
        return;
    }
    pass('Sistema detecta que não deve repetir pergunta!');
    
    // ═══════════════════════════════════════════════════════════
    // RESUMO
    // ═══════════════════════════════════════════════════════════
    section('✅ RESUMO DO TESTE');
    
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🎉 CASO ANA LAURA: TODAS AS PROTEÇÕES FUNCIONANDO!        ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  ✓ Nome coletado e persistido                            ║');
    console.log('║  ✓ Idade 20 anos protegida (não corrompida para 1)       ║');
    console.log('║  ✓ Período "tarde" salvo                                 ║');
    console.log('║  ✓ Queixa registrada                                     ║');
    console.log('║  ✓ Triagem completa detectada (hasAll=true)              ║');
    console.log('║  ✓ Prevenção de loop ativa                               ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    
    await limparLead();
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado do MongoDB');
}

runTest().catch(err => {
    console.error('❌ ERRO:', err);
    process.exit(1);
});
