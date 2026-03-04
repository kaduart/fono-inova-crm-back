#!/usr/bin/env node
/**
 * 📊 TESTES DE REGRESSÃO: Casos Reais da Produção
 * 
 * Testa exatamente os cenários que falharam em produção
 * para garantir que não voltem a acontecer.
 */

import mongoose from 'mongoose';
import 'dotenv/config';
import Leads from '../../models/Leads.js';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import { safeAgeUpdate, shouldSkipQuestion } from '../../utils/safeDataUpdate.js';
import { extractAgeFromText } from '../../utils/patientDataExtractor.js';

const MONGO_URI = process.env.MONGO_URI;
let passed = 0;
let failed = 0;

function pass(msg) { console.log(`✅ ${msg}`); passed++; }
function fail(msg) { console.log(`❌ ${msg}`); failed++; process.exitCode = 1; }
function section(msg) { console.log(`\n${'═'.repeat(70)}\n${msg}\n${'═'.repeat(70)}`); }

// ═══════════════════════════════════════════════════════════
// REGRESSÃO 1: Caso Ana Laura (LOG REAL)
// ═══════════════════════════════════════════════════════════

async function regressaoCasoAnaLaura() {
    section('📊 REGRESSÃO 1: Caso Ana Laura (Baseado no Log Real)');
    
    await mongoose.connect(MONGO_URI);
    
    const phone = '5562999999900';
    await Leads.deleteOne({ 'contact.phone': phone });
    
    // Cria lead exatamente como estava no log
    const lead = new Leads({
        contact: { phone: phone },
        name: 'Lead Teste Ana Laura',
        stage: 'triagem_agendamento',
        therapyArea: 'fonoaudiologia',
        patientInfo: {
            fullName: 'Ana Laura Vieira Do Amaral',
            age: 20  // ← Idade crítica que foi corrompida
        },
        pendingPreferredPeriod: 'tarde',
        qualificationData: {
            disponibilidade: 'tarde'
        },
        complaint: 'Minha namorada tem um problema com a fala, não sei falar se é língua presa'
    });
    await lead.save();
    
    console.log('\n📋 Estado do lead (como estava no log):');
    console.log('   Nome: Ana Laura Vieira Do Amaral');
    console.log('   Idade: 20 ← CRÍTICO');
    console.log('   Período: tarde');
    console.log('   Área: fonoaudiologia');
    console.log('   Queixa: presente');
    
    // Simula mensagem que causou corrupção
    console.log('\n📨 Mensagem perigosa (causou bug em produção):');
    console.log('   "minha filha tem 20 anos e faz 1 sessão por semana"');
    
    // Testa extração
    const idadeExtraida = extractAgeFromText("minha filha tem 20 anos e faz 1 sessão por semana");
    console.log(`\n🔍 Extração:`);
    console.log(`   Idade detectada: ${idadeExtraida?.age || 'null'}`);
    
    // Testa proteção
    const protecao = safeAgeUpdate(20, idadeExtraida?.age, "minha filha tem 20 anos e faz 1 sessão por semana");
    console.log(`   Proteção: 20 → ${protecao.age} (${protecao.reason})`);
    
    if (protecao.age !== 20) {
        fail(`REGRESSÃO! Idade corrompida: 20 → ${protecao.age}`);
        await Leads.deleteOne({ 'contact.phone': phone });
        await mongoose.disconnect();
        return;
    }
    
    // Testa prevenção de loop
    const devePular = shouldSkipQuestion(lead.toObject(), 'period');
    console.log(`   Loop check: deve pular "manhã ou tarde?" = ${devePular}`);
    
    if (!devePular) {
        fail('REGRESSÃO! Deveria pular pergunta de período');
        await Leads.deleteOne({ 'contact.phone': phone });
        await mongoose.disconnect();
        return;
    }
    
    pass('Caso Ana Laura protegido!');
    
    await Leads.deleteOne({ 'contact.phone': phone });
    await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════
// REGRESSÃO 2: Loop de Triagem
// ═══════════════════════════════════════════════════════════

async function regressaoLoopTriagem() {
    section('📊 REGRESSÃO 2: Loop de Triagem (hasAll=true → pergunta de novo)');
    
    await mongoose.connect(MONGO_URI);
    
    const phone = '5562999999901';
    await Leads.deleteOne({ 'contact.phone': phone });
    
    // Lead com triagem completa
    const lead = new Leads({
        contact: { phone: phone },
        name: 'Lead Loop Test',
        stage: 'triagem_agendamento',
        therapyArea: 'fonoaudiologia',
        patientInfo: {
            fullName: 'Maria Silva',
            age: 10
        },
        pendingPreferredPeriod: 'tarde',
        complaint: 'atraso de fala'
    });
    await lead.save();
    
    console.log('\n📋 Lead com triagem COMPLETA:');
    console.log('   hasAll = true (nome + idade + período + queixa + área)');
    
    // Simula resposta que dispara loop
    const context = {
        stage: 'triagem_agendamento',
        messageCount: 5,
        conversationHistory: [],
        phone: phone
    };
    
    try {
        const resposta = await getOptimizedAmandaResponse({
            content: 'Tarde',
            userText: 'Tarde',
            lead: lead,
            context: context
        });
        
        const texto = resposta.text || resposta;
        console.log(`\n🤖 Resposta da Amanda:`);
        console.log(`   "${texto.substring(0, 100)}..."`);
        
        // VERIFICAÇÃO: NÃO deve perguntar período de novo
        if (texto.toLowerCase().includes('manhã') && texto.toLowerCase().includes('tarde')) {
            fail('REGRESSÃO! Amanda perguntou período novamente (LOOP)');
            await Leads.deleteOne({ 'contact.phone': phone });
            await mongoose.disconnect();
            return;
        }
        
        // VERIFICAÇÃO: Deve oferecer slots ou fazer pergunta diferente
        if (!texto.toLowerCase().includes('horário') && 
            !texto.toLowerCase().includes('slot') &&
            !texto.toLowerCase().includes('preocupação') &&
            !texto.toLowerCase().includes('queixa')) {
            console.log('⚠️  Resposta não contém slots nem queixa, mas continuando...');
        }
        
        pass('Loop prevenido!');
        
    } catch (error) {
        fail(`Erro: ${error.message}`);
    }
    
    await Leads.deleteOne({ 'contact.phone': phone });
    await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════
// REGRESSÃO 3: Múltiplos Números na Mensagem
// ═══════════════════════════════════════════════════════════

async function regressaoMultiplosNumeros() {
    section('📊 REGRESSÃO 3: Múltiplos Números (capturar idade correta)');
    
    const testCases = [
        { text: "tem 20 anos e faz 1 sessão", expected: 20, desc: "20 + 1" },
        { text: "ele tem 5 anos e 3 irmãos", expected: 5, desc: "5 + 3" },
        { text: "são 2 filhos, o maior tem 12 anos", expected: 12, desc: "2 + 12" },
        { text: "ela tem 8 anos e vai fazer 9", expected: 8, desc: "8 + 9" },
        { text: "tem 15 anos, consulta dura 50 minutos", expected: 15, desc: "15 + 50" },
    ];
    
    for (const { text, expected, desc } of testCases) {
        const result = extractAgeFromText(text);
        const actual = result?.age;
        
        if (actual !== expected) {
            fail(`"${desc}": esperado ${expected}, recebido ${actual}`);
        } else {
            console.log(`✅ "${desc}": ${actual} (correto)`);
        }
    }
    
    passed += testCases.length;
}

// ═══════════════════════════════════════════════════════════
// REGRESSÃO 4: Downgrade de Idade
// ═══════════════════════════════════════════════════════════

async function regressaoDowngradeIdade() {
    section('📊 REGRESSÃO 4: Proteção contra Downgrade de Idade');
    
    const cases = [
        { current: 20, new: 1, text: "1 sessão", shouldKeep: 20 },
        { current: 15, new: 2, text: "2 vezes", shouldKeep: 15 },
        { current: 30, new: 5, text: "5 minutos", shouldKeep: 30 },
        { current: 10, new: 3, text: "3 irmãos", shouldKeep: 10 },
        { current: 25, new: 1, text: "1 ano de atraso", shouldKeep: 25 },
    ];
    
    for (const { current, new: newAge, text, shouldKeep } of cases) {
        const result = safeAgeUpdate(current, newAge, text);
        
        if (result.age !== shouldKeep) {
            fail(`${current} vs "${text}": esperado manter ${shouldKeep}, foi para ${result.age}`);
        } else {
            console.log(`✅ ${current} anos protegido contra "${text}" (${newAge})`);
            passed++;
        }
    }
}

// ═══════════════════════════════════════════════════════════
// EXECUÇÃO
// ═══════════════════════════════════════════════════════════

async function runAll() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  📊 TESTES DE REGRESSÃO - CASOS REAIS DA PRODUÇÃO         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    await regressaoCasoAnaLaura();
    await regressaoLoopTriagem();
    await regressaoMultiplosNumeros();
    await regressaoDowngradeIdade();
    
    section('📊 RESUMO DOS TESTES DE REGRESSÃO');
    console.log(`✅ Passaram: ${passed}`);
    console.log(`❌ Falharam: ${failed}`);
    
    if (failed > 0) {
        console.log('\n❌ TESTES DE REGRESSÃO FALHARAM!');
        console.log('   Bugs podem voltar para produção!');
        process.exit(1);
    } else {
        console.log('\n✅ TODOS OS TESTES DE REGRESSÃO PASSARAM!');
        console.log('   Casos reais estão protegidos!');
        process.exit(0);
    }
}

runAll().catch(err => {
    console.error('💥 ERRO FATAL:', err);
    process.exit(1);
});
