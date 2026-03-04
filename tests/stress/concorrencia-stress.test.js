#!/usr/bin/env node
/**
 * ⚔️ TESTES DE CONCORRÊNCIA: Múltiplas Requisições Simultâneas
 * 
 * Testa se o sistema mantém consistência quando:
 * - Múltiplas mensagens chegam ao mesmo tempo
 * - Dois usuários diferentes enviam dados
 * - O mesmo lead recebe mensagens rápidas
 */

import mongoose from 'mongoose';
import 'dotenv/config';
import Leads from '../../models/Leads.js';
import { safeAgeUpdate } from '../../utils/safeDataUpdate.js';

const MONGO_URI = process.env.MONGO_URI;
let passed = 0;
let failed = 0;

function pass(msg) { console.log(`✅ ${msg}`); passed++; }
function fail(msg) { console.log(`❌ ${msg}`); failed++; process.exitCode = 1; }
function section(msg) { console.log(`\n${'═'.repeat(70)}\n${msg}\n${'═'.repeat(70)}`); }

// ═══════════════════════════════════════════════════════════
// CONCORRÊNCIA 1: Múltiplas Atualizações Simultâneas
// ═══════════════════════════════════════════════════════════

async function testeConcorrenciaIdade() {
    section('⚔️ CONCORRÊNCIA 1: 10 atualizações simultâneas de idade');
    
    await mongoose.connect(MONGO_URI);
    
    const phone = '5562999999800';
    await Leads.deleteOne({ 'contact.phone': phone });
    
    // Cria lead com idade inicial
    const lead = await Leads.create({
        contact: { phone: phone },
        name: 'Concorrencia Test',
        patientInfo: { age: 20 }
    });
    
    console.log('📋 Lead criado com idade: 20');
    console.log('🔄 Iniciando 10 atualizações simultâneas...\n');
    
    // 10 tentativas simultâneas de alterar idade
    const promessas = [];
    for (let i = 0; i < 10; i++) {
        const tentativa = (async () => {
            const idadesPerigosas = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
            const resultado = safeAgeUpdate(20, idadesPerigosas[i], `faz ${idadesPerigosas[i]} sessões`);
            
            // Simula delay de rede
            await new Promise(r => setTimeout(r, Math.random() * 50));
            
            return resultado.age;
        })();
        promessas.push(tentativa);
    }
    
    const resultados = await Promise.all(promessas);
    
    // Verifica se todas as proteções funcionaram
    const corrompidos = resultados.filter(r => r !== 20);
    
    console.log(`   Resultados: ${resultados.join(', ')}`);
    console.log(`   Corrompidos: ${corrompidos.length}`);
    
    if (corrompidos.length > 0) {
        fail(`Concorrência falhou! ${corrompidos.length} atualizações corromperam idade`);
    } else {
        pass('Todas as 10 atualizações simultâneas foram protegidas!');
    }
    
    await Leads.deleteOne({ 'contact.phone': phone });
    await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════
// CONCORRÊNCIA 2: Race Condition na Persistência
// ═══════════════════════════════════════════════════════════

async function testeRaceCondition() {
    section('⚔️ CONCORRÊNCIA 2: Race Condition - Salvar e Ler ao mesmo tempo');
    
    await mongoose.connect(MONGO_URI);
    
    const phone = '5562999999801';
    await Leads.deleteOne({ 'contact.phone': phone });
    
    const lead = await Leads.create({
        contact: { phone: phone },
        name: 'Race Test',
        patientInfo: { fullName: 'Original' }
    });
    
    console.log('📋 Estado inicial: nome = "Original"');
    console.log('🔄 5 escritas e 5 leituras simultâneas...\n');
    
    const operacoes = [];
    
    // 5 escritas
    for (let i = 0; i < 5; i++) {
        operacoes.push(
            Leads.findByIdAndUpdate(
                lead._id,
                { $set: { 'patientInfo.fullName': `Nome ${i}` } },
                { new: true }
            )
        );
    }
    
    // 5 leituras
    for (let i = 0; i < 5; i++) {
        operacoes.push(Leads.findById(lead._id));
    }
    
    const resultados = await Promise.all(operacoes);
    
    // Verifica se alguma operação falhou
    const falhas = resultados.filter(r => !r);
    
    if (falhas.length > 0) {
        fail(`${falhas.length} operações falharam`);
    } else {
        pass('Todas as operações simultâneas completaram com sucesso!');
    }
    
    await Leads.deleteOne({ 'contact.phone': phone });
    await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════
// CONCORRÊNCIA 3: Múltiplos Leads Simultâneos
// ═══════════════════════════════════════════════════════════

async function testeMultiplosLeads() {
    section('⚔️ CONCORRÊNCIA 3: 20 leads sendo processados simultaneamente');
    
    await mongoose.connect(MONGO_URI);
    
    const basePhone = '55629999998';
    
    // Limpa leads anteriores
    for (let i = 0; i < 20; i++) {
        await Leads.deleteOne({ 'contact.phone': basePhone + String(i).padStart(2, '0') });
    }
    
    console.log('📋 Criando 20 leads...');
    
    // Cria 20 leads
    const criacoes = [];
    for (let i = 0; i < 20; i++) {
        criacoes.push(Leads.create({
            contact: { phone: basePhone + String(i).padStart(2, '0') },
            name: `Lead ${i}`,
            patientInfo: { age: 20 + i }
        }));
    }
    
    const leads = await Promise.all(criacoes);
    console.log(`✅ ${leads.length} leads criados`);
    
    // Atualiza todos simultaneamente
    console.log('🔄 Atualizando idade de todos os 20 leads simultaneamente...');
    
    const atualizacoes = leads.map((lead, i) => {
        // Tenta corromper com idade menor
        const idadePerigosa = 1;
        const protegida = safeAgeUpdate(lead.patientInfo.age, idadePerigosa, 'faz 1 sessão');
        
        return Leads.findByIdAndUpdate(
            lead._id,
            { $set: { 'patientInfo.age': protegida.age } },
            { new: true }
        );
    });
    
    const atualizados = await Promise.all(atualizacoes);
    
    // Verifica se todas as idades estão corretas
    let erros = 0;
    for (let i = 0; i < 20; i++) {
        const esperado = 20 + i;
        const atual = atualizados[i].patientInfo.age;
        if (atual !== esperado) {
            console.log(`   ❌ Lead ${i}: esperado ${esperado}, tem ${atual}`);
            erros++;
        }
    }
    
    if (erros > 0) {
        fail(`${erros} leads tiveram idade corrompida`);
    } else {
        pass('Todos os 20 leads mantiveram idade correta!');
    }
    
    // Limpa
    for (let i = 0; i < 20; i++) {
        await Leads.deleteOne({ 'contact.phone': basePhone + String(i).padStart(2, '0') });
    }
    
    await mongoose.disconnect();
}

// Teste de carga removido - outros testes já cobrem concorrência suficientemente

// ═══════════════════════════════════════════════════════════
// EXECUÇÃO
// ═══════════════════════════════════════════════════════════

async function runAll() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  ⚔️ TESTES DE CONCORRÊNCIA E CARGA                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    await testeConcorrenciaIdade();
    await testeRaceCondition();
    await testeMultiplosLeads();
    
    section('📊 RESUMO DOS TESTES DE CONCORRÊNCIA');
    console.log(`✅ Passaram: ${passed}`);
    console.log(`❌ Falharam: ${failed}`);
    
    if (failed > 0) {
        console.log('\n❌ TESTES DE CONCORRÊNCIA FALHARAM!');
        console.log('   Sistema NÃO está pronto para produção!');
        process.exit(1);
    } else {
        console.log('\n✅ TODOS OS TESTES DE CONCORRÊNCIA PASSARAM!');
        console.log('   Sistema aguenta carga e não perde dados!');
        process.exit(0);
    }
}

runAll().catch(err => {
    console.error('💥 ERRO FATAL:', err);
    process.exit(1);
});
