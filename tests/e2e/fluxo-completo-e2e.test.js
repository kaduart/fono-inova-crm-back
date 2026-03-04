#!/usr/bin/env node
/**
 * 🎭 TESTES E2E: Fluxo Completo End-to-End
 * 
 * Simula conversas reais de ponta a ponta usando o AmandaOrchestrator real.
 * Testa o fluxo completo: mensagem → processamento → resposta → persistência
 */

import mongoose from 'mongoose';
import 'dotenv/config';
import Leads from '../../models/Leads.js';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';

const MONGO_URI = process.env.MONGO_URI;
const PHONE_BASE = '55629999999';

let testCounter = 0;
let passed = 0;
let failed = 0;

function pass(msg) { console.log(`✅ ${msg}`); passed++; }
function fail(msg) { console.log(`❌ ${msg}`); failed++; process.exitCode = 1; }
function section(msg) { console.log(`\n${'═'.repeat(70)}\n${msg}\n${'═'.repeat(70)}`); }

async function connect() {
    await mongoose.connect(MONGO_URI);
    console.log('🔌 Conectado ao MongoDB\n');
}

async function limparTestes() {
    await Leads.deleteMany({ 'contact.phone': { $regex: '^' + PHONE_BASE } });
}

async function criarLead(phoneSuffix) {
    const lead = new Leads({
        contact: { phone: PHONE_BASE + phoneSuffix },
        name: `Lead Teste ${phoneSuffix}`,
        stage: 'novo',
        createdAt: new Date()
    });
    await lead.save();
    return lead;
}

async function enviarMensagem(lead, texto, historico = []) {
    const leadAtual = await Leads.findById(lead._id);
    
    const context = {
        stage: leadAtual?.stage || 'novo',
        messageCount: historico.length,
        conversationHistory: historico.map(h => ({
            role: h.autor === 'Cliente' ? 'user' : 'assistant',
            content: h.texto
        })),
        phone: lead.contact.phone
    };

    try {
        const resposta = await getOptimizedAmandaResponse({
            content: texto,
            userText: texto,
            lead: leadAtual,
            context: context
        });
        
        await new Promise(r => setTimeout(r, 300));
        
        return {
            texto: resposta.text || resposta,
            lead: await Leads.findById(lead._id),
            error: null
        };
    } catch (error) {
        return { texto: '[ERRO]', lead: leadAtual, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════
// TESTE E2E 1: Fluxo Completo - Fono com Adulto
// ═══════════════════════════════════════════════════════════

async function testeFluxoCompletoFono() {
    section('🎭 TESTE E2E 1: Fluxo Completo - Fonoaudiologia Adulto');
    
    const lead = await criarLead('00');
    const historico = [];
    
    // Mensagem 1: Apresentação
    console.log('\n📨 [Cliente]: "Oi, sou Maria. Quero agendar fonoaudiologia"');
    let resp = await enviarMensagem(lead, 'Oi, sou Maria. Quero agendar fonoaudiologia', historico);
    historico.push({ autor: 'Cliente', texto: 'Oi, sou Maria. Quero agendar fonoaudiologia' });
    
    if (resp.error) {
        fail(`Erro na resposta: ${resp.error}`);
        return;
    }
    
    console.log(`🤖 [Amanda]: "${resp.texto.substring(0, 100)}..."`);
    historico.push({ autor: 'Amanda', texto: resp.texto });
    
    // Verifica se perguntou nome
    if (!resp.texto.toLowerCase().includes('nome')) {
        fail('Amanda deveria perguntar o nome');
        return;
    }
    pass('Mensagem 1: Perguntou nome do paciente');
    
    // Mensagem 2: Responde nome
    console.log('\n📨 [Cliente]: "Ana Laura Vieira"');
    resp = await enviarMensagem(lead, 'Ana Laura Vieira', historico);
    historico.push({ autor: 'Cliente', texto: 'Ana Laura Vieira' });
    
    console.log(`🤖 [Amanda]: "${resp.texto.substring(0, 100)}..."`);
    historico.push({ autor: 'Amanda', texto: resp.texto });
    
    // Verifica se salvou nome
    if (!resp.lead.patientInfo?.fullName?.includes('Ana')) {
        fail(`Nome não persistido: ${JSON.stringify(resp.lead.patientInfo)}`);
        return;
    }
    pass(`Mensagem 2: Nome persistido: ${resp.lead.patientInfo.fullName}`);
    
    // Mensagem 3: Responde idade
    console.log('\n📨 [Cliente]: "20 anos"');
    resp = await enviarMensagem(lead, '20 anos', historico);
    historico.push({ autor: 'Cliente', texto: '20 anos' });
    
    console.log(`🤖 [Amanda]: "${resp.texto.substring(0, 100)}..."`);
    
    // Verifica se salvou idade
    if (resp.lead.patientInfo?.age !== 20) {
        fail(`Idade não persistida ou incorreta: ${resp.lead.patientInfo?.age}`);
        return;
    }
    pass(`Mensagem 3: Idade persistida: ${resp.lead.patientInfo.age}`);
    
    // Mensagem 4: Responde período
    console.log('\n📨 [Cliente]: "tarde"');
    resp = await enviarMensagem(lead, 'tarde', historico);
    historico.push({ autor: 'Cliente', texto: 'tarde' });
    
    console.log(`🤖 [Amanda]: "${resp.texto.substring(0, 100)}..."`);
    
    // Verifica se salvou período
    if (!resp.lead.pendingPreferredPeriod && !resp.lead.qualificationData?.disponibilidade) {
        fail('Período não persistido');
        return;
    }
    pass(`Mensagem 4: Período persistido`);
    
    // Mensagem 5: Descreve queixa
    console.log('\n📨 [Cliente]: "Tenho problema na fala, gaguejo"');
    resp = await enviarMensagem(lead, 'Tenho problema na fala, gaguejo', historico);
    historico.push({ autor: 'Cliente', texto: 'Tenho problema na fala, gaguejo' });
    
    console.log(`🤖 [Amanda]: "${resp.texto.substring(0, 150)}..."`);
    
    // Verifica se tem queixa
    if (!resp.lead.complaint && !resp.texto.toLowerCase().includes('horário') && !resp.texto.toLowerCase().includes('slot')) {
        fail('Deveria ter queixa ou oferecer slots');
        return;
    }
    pass('Mensagem 5: Queixa coletada ou slots oferecidos');
    
    // VERIFICAÇÃO CRÍTICA: Dados não foram corrompidos
    const leadFinal = resp.lead;
    console.log('\n🔍 Verificação final dos dados:');
    console.log(`   Nome: ${leadFinal.patientInfo?.fullName}`);
    console.log(`   Idade: ${leadFinal.patientInfo?.age}`);
    console.log(`   Período: ${leadFinal.pendingPreferredPeriod || leadFinal.qualificationData?.disponibilidade}`);
    console.log(`   Área: ${leadFinal.therapyArea}`);
    
    if (leadFinal.patientInfo?.age !== 20) {
        fail(`IDADE CORROMPIDA! Era 20, virou ${leadFinal.patientInfo?.age}`);
        return;
    }
    
    if (!leadFinal.patientInfo?.fullName?.includes('Ana')) {
        fail('NOME CORROMPIDO!');
        return;
    }
    
    pass('✅ Dados persistidos corretamente SEM CORRUPÇÃO!');
}

// ═══════════════════════════════════════════════════════════
// TESTE E2E 2: Proteção contra Loop
// ═══════════════════════════════════════════════════════════

async function testeProtecaoLoop() {
    section('🔄 TESTE E2E 2: Proteção contra Loop de Triagem');
    
    const lead = await criarLead('01');
    const historico = [];
    
    // Pre-popula dados (simula estado após triagem completa)
    await Leads.findByIdAndUpdate(lead._id, {
        'patientInfo.fullName': 'João Silva',
        'patientInfo.age': 25,
        'pendingPreferredPeriod': 'manha',
        'therapyArea': 'psicologia',
        'complaint': 'ansiedade',
        'stage': 'triagem_agendamento'
    });
    
    console.log('\n📋 Estado inicial do lead:');
    console.log('   ✓ Nome: João Silva');
    console.log('   ✓ Idade: 25');
    console.log('   ✓ Período: manha');
    console.log('   ✓ Queixa: ansiedade');
    console.log('   ✓ Área: psicologia');
    
    // Cliente manda mensagem não relacionada
    console.log('\n📨 [Cliente]: "Quanto custa a sessão?"');
    let resp = await enviarMensagem(lead, 'Quanto custa a sessão?', historico);
    
    console.log(`🤖 [Amanda]: "${resp.texto.substring(0, 150)}..."`);
    
    // Verifica se respondeu preço
    if (!resp.texto.includes('R$') && !resp.texto.toLowerCase().includes('valor')) {
        console.log('⚠️  Resposta pode não ter preço, mas verificando persistência...');
    }
    
    // VERIFICAÇÃO CRÍTICA: NÃO deve perguntar período de novo
    if (resp.texto.toLowerCase().includes('manhã') && resp.texto.toLowerCase().includes('tarde')) {
        fail('LOOP DETECTADO! Amanda perguntou período novamente!');
        return;
    }
    
    // VERIFICAÇÃO CRÍTICA: Dados não devem ser perdidos
    const leadAtual = resp.lead;
    if (leadAtual.patientInfo?.age !== 25) {
        fail(`IDADE PERDIDA! Era 25, virou ${leadAtual.patientInfo?.age}`);
        return;
    }
    
    pass('✅ Loop prevenido! Dados mantidos!');
}

// ═══════════════════════════════════════════════════════════
// TESTE E2E 3: Proteção contra Corrupção de Idade
// ═══════════════════════════════════════════════════════════

async function testeProtecaoIdade() {
    section('🛡️ TESTE E2E 3: Proteção contra Corrupção de Idade');
    
    const lead = await criarLead('02');
    const historico = [];
    
    // Pre-popula com idade 20
    await Leads.findByIdAndUpdate(lead._id, {
        'patientInfo.fullName': 'Maria',
        'patientInfo.age': 20,
        'pendingPreferredPeriod': 'tarde',
        'therapyArea': 'fonoaudiologia',
        'stage': 'triagem_agendamento'
    });
    
    console.log('\n📋 Estado inicial: Maria, 20 anos, fonoaudiologia');
    
    // Cliente manda mensagem com número que poderia corromper idade
    console.log('\n📨 [Cliente]: "Ela faz 1 sessão por semana de fonoaudiologia"');
    let resp = await enviarMensagem(lead, 'Ela faz 1 sessão por semana de fonoaudiologia', historico);
    
    console.log(`🤖 [Amanda]: "${resp.texto.substring(0, 150)}..."`);
    
    // VERIFICAÇÃO CRÍTICA: Idade DEVE continuar 20
    const leadAtual = resp.lead;
    console.log(`🔍 Idade no banco: ${leadAtual.patientInfo?.age}`);
    
    if (leadAtual.patientInfo?.age !== 20) {
        fail(`CORRUPÇÃO DETECTADA! Era 20, virou ${leadAtual.patientInfo?.age}`);
        return;
    }
    
    pass('✅ Idade protegida! Manteve 20 anos!');
}

// ═══════════════════════════════════════════════════════════
// EXECUÇÃO
// ═══════════════════════════════════════════════════════════

async function runAll() {
    await connect();
    await limparTestes();
    
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🎭 TESTES E2E - FLUXO COMPLETO END-TO-END                ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    
    try {
        await testeFluxoCompletoFono();
    } catch (e) {
        console.error('Erro no teste 1:', e);
        failed++;
    }
    
    try {
        await testeProtecaoLoop();
    } catch (e) {
        console.error('Erro no teste 2:', e);
        failed++;
    }
    
    try {
        await testeProtecaoIdade();
    } catch (e) {
        console.error('Erro no teste 3:', e);
        failed++;
    }
    
    await limparTestes();
    await mongoose.disconnect();
    
    section('📊 RESUMO DOS TESTES E2E');
    console.log(`✅ Passaram: ${passed}`);
    console.log(`❌ Falharam: ${failed}`);
    
    if (failed > 0) {
        console.log('\n❌ TESTES E2E FALHARAM!');
        process.exit(1);
    } else {
        console.log('\n✅ TODOS OS TESTES E2E PASSARAM!');
        process.exit(0);
    }
}

runAll().catch(err => {
    console.error('💥 ERRO FATAL:', err);
    process.exit(1);
});
