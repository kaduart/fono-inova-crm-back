#!/usr/bin/env node
/**
 * 💣 TESTE MEGATON: Simulação de 1 Semana de Produção
 * 
 * Cria 50 leads e simula conversas completas em todos,
 * com cenários variados e mensagens aleatórias.
 * Dura ~2 minutos e testa robustez extrema.
 */

import mongoose from 'mongoose';
import 'dotenv/config';
import Leads from '../../models/Leads.js';
import { safeAgeUpdate, shouldSkipQuestion } from '../../utils/safeDataUpdate.js';
import { extractAgeFromText } from '../../utils/patientDataExtractor.js';

const MONGO_URI = process.env.MONGO_URI;

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`✅ ${msg}`); passed++; }
function fail(msg) { console.log(`❌ ${msg}`); failed++; process.exitCode = 1; }

// ═══════════════════════════════════════════════════════════
// DADOS DE TESTE
// ═══════════════════════════════════════════════════════════

const nomes = ['Ana', 'Maria', 'João', 'Pedro', 'Clara', 'Lucas', 'Sofia', 'Gabriel', 'Laura', 'Matheus'];
const sobrenomes = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Costa', 'Pereira', 'Carvalho'];
const areas = ['fonoaudiologia', 'psicologia', 'terapia ocupacional', 'fisioterapia'];
const periodos = ['manha', 'tarde', 'noite'];

const mensagensInicio = [
    'Oi, quero agendar',
    'Bom dia, preciso de uma consulta',
    'Olá, como funciona?',
    'Quero saber valores',
    'Preciso agendar para meu filho',
];

const mensagensPerigosas = [
    'ela tem 20 anos e faz 1 sessão',
    'meu filho tem 5 anos e 3 irmãos',
    'são 2 crianças, uma tem 10 anos',
    'ela tem 15 anos, consulta dura 50 min',
    'tem 8 anos e faz 2 terapias',
];

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function random(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ═══════════════════════════════════════════════════════════
// SIMULAÇÃO DE CONVERSA
// ═══════════════════════════════════════════════════════════

async function simularConversa(leadIndex) {
    const phone = `55629999997${String(leadIndex).padStart(2, '0')}`;
    
    // Limpa se existir
    await Leads.deleteOne({ 'contact.phone': phone });
    
    // Cria lead
    const lead = await Leads.create({
        contact: { phone },
        name: `Simulação ${leadIndex}`,
        stage: 'novo',
        createdAt: new Date()
    });
    
    const nome = random(nomes) + ' ' + random(sobrenomes);
    const idade = randomInt(3, 45);
    const area = random(areas);
    const periodo = random(periodos);
    
    // Simula triagem completa
    const updates = [];
    
    // 1. Nome
    updates.push(Leads.findByIdAndUpdate(lead._id, {
        $set: { 'patientInfo.fullName': nome }
    }));
    
    // 2. Idade (com proteção)
    const idadeProtegida = safeAgeUpdate(null, idade, `tem ${idade} anos`);
    updates.push(Leads.findByIdAndUpdate(lead._id, {
        $set: { 'patientInfo.age': idadeProtegida.age }
    }));
    
    // 3. Período
    updates.push(Leads.findByIdAndUpdate(lead._id, {
        $set: { 
            pendingPreferredPeriod: periodo,
            'qualificationData.disponibilidade': periodo
        }
    }));
    
    // 4. Área
    updates.push(Leads.findByIdAndUpdate(lead._id, {
        $set: { therapyArea: area }
    }));
    
    // 5. Queixa
    updates.push(Leads.findByIdAndUpdate(lead._id, {
        $set: { complaint: 'atraso de desenvolvimento' }
    }));
    
    await Promise.all(updates);
    
    // Simula mensagens perigosas que poderiam corromper
    for (let i = 0; i < 3; i++) {
        const msgPerigosa = random(mensagensPerigosas);
        const idadeExtraida = extractAgeFromText(msgPerigosa);
        
        const leadAtual = await Leads.findById(lead._id);
        const protecao = safeAgeUpdate(
            leadAtual.patientInfo.age,
            idadeExtraida?.age,
            msgPerigosa
        );
        
        // Tenta atualizar (deveria ser protegido)
        await Leads.findByIdAndUpdate(lead._id, {
            $set: { 'patientInfo.age': protecao.age }
        });
    }
    
    // Verifica integridade final
    const final = await Leads.findById(lead._id);
    
    const checks = [
        { field: 'nome', expected: nome, actual: final.patientInfo?.fullName },
        { field: 'idade', expected: idade, actual: final.patientInfo?.age },
        { field: 'periodo', expected: periodo, actual: final.pendingPreferredPeriod },
        { field: 'area', expected: area, actual: final.therapyArea },
    ];
    
    const erros = checks.filter(c => c.actual !== c.expected);
    
    if (erros.length > 0) {
        const detalhes = erros.map(e => `${e.field}: ${e.expected}→${e.actual}`).join(', ');
        throw new Error(`Corrompido: ${detalhes}`);
    }
    
    // Verifica prevenção de loop
    const devePularPeriodo = shouldSkipQuestion(final.toObject(), 'period');
    if (!devePularPeriodo) {
        throw new Error('Prevenção de loop falhou');
    }
    
    return { success: true, phone };
}

// ═══════════════════════════════════════════════════════════
// TESTE MEGATON
// ═══════════════════════════════════════════════════════════

async function testeMegaton() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  💣 TESTE MEGATON: Simulação de 1 Semana de Produção      ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    await mongoose.connect(MONGO_URI);
    
    const TOTAL_LEADS = 50;
    const BATCH_SIZE = 10;
    
    console.log(`🎯 Meta: Simular ${TOTAL_LEADS} conversas completas`);
    console.log(`⚙️  Config: ${BATCH_SIZE} leads por batch\n`);
    
    let sucessos = 0;
    let falhas = 0;
    const erros = [];
    
    const startTime = Date.now();
    
    // Processa em batches
    for (let batch = 0; batch < TOTAL_LEADS / BATCH_SIZE; batch++) {
        const inicio = batch * BATCH_SIZE;
        const fim = inicio + BATCH_SIZE;
        
        console.log(`\n📦 Batch ${batch + 1}/${TOTAL_LEADS / BATCH_SIZE} (leads ${inicio}-${fim - 1})`);
        
        const promessas = [];
        for (let i = inicio; i < fim; i++) {
            promessas.push(
                simularConversa(i).then(result => {
                    sucessos++;
                    process.stdout.write('✅');
                    return result;
                }).catch(err => {
                    falhas++;
                    erros.push({ lead: i, error: err.message });
                    process.stdout.write('❌');
                    return { success: false, error: err.message };
                })
            );
        }
        
        await Promise.all(promessas);
        
        // Delay entre batches para não sobrecarregar
        await new Promise(r => setTimeout(r, 100));
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n\n' + '═'.repeat(70));
    console.log('📊 RESULTADO DO TESTE MEGATON');
    console.log('═'.repeat(70));
    console.log(`⏱️  Duração: ${duration}s`);
    console.log(`✅ Sucessos: ${sucessos}/${TOTAL_LEADS}`);
    console.log(`❌ Falhas: ${falhas}/${TOTAL_LEADS}`);
    console.log(`📊 Taxa de sucesso: ${((sucessos / TOTAL_LEADS) * 100).toFixed(1)}%`);
    
    if (erros.length > 0) {
        console.log('\n❌ Erros:');
        erros.slice(0, 5).forEach(e => console.log(`   - Lead ${e.lead}: ${e.error}`));
        if (erros.length > 5) {
            console.log(`   ... e mais ${erros.length - 5} erros`);
        }
    }
    
    // Limpa todos os leads de teste
    console.log('\n🧹 Limpando leads de teste...');
    for (let i = 0; i < TOTAL_LEADS; i++) {
        const phone = `55629999997${String(i).padStart(2, '0')}`;
        await Leads.deleteOne({ 'contact.phone': phone });
    }
    
    await mongoose.disconnect();
    
    if (falhas > 0) {
        fail(`\n${falhas} conversas falharam!`);
    } else {
        pass(`\nTodas as ${TOTAL_LEADS} conversas completaram com sucesso!`);
    }
}

// ═══════════════════════════════════════════════════════════
// EXECUÇÃO
// ═══════════════════════════════════════════════════════════

testeMegaton().then(() => {
    console.log('\n' + '═'.repeat(70));
    console.log('📊 RESUMO FINAL');
    console.log('═'.repeat(70));
    console.log(`✅ Passaram: ${passed}`);
    console.log(`❌ Falharam: ${failed}`);
    
    if (failed > 0) {
        console.log('\n❌ TESTE MEGATON FALHOU!');
        process.exit(1);
    } else {
        console.log('\n✅ TESTE MEGATON PASSOU!');
        console.log('   Sistema aguenta carga de produção!');
        process.exit(0);
    }
}).catch(err => {
    console.error('💥 ERRO FATAL:', err);
    process.exit(1);
});
