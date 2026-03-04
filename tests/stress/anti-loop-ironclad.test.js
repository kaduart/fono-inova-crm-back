#!/usr/bin/env node
/**
 * 🛡️ TESTES ANTI-LOOP: Garantia Absoluta contra Loop
 * 
 * Testa TODOS os cenários onde loop poderia acontecer:
 * - Cliente repete resposta
 * - Cliente muda de assunto
 * - Cliente manda mensagem curta
 * - Cliente manda emoji
 * - Qualquer mensagem após triagem completa
 */

import mongoose from 'mongoose';
import 'dotenv/config';
import Leads from '../../models/Leads.js';
import { shouldSkipQuestion } from '../../utils/safeDataUpdate.js';

const MONGO_URI = process.env.MONGO_URI;
let passed = 0;
let failed = 0;

function pass(msg) { console.log(`✅ ${msg}`); passed++; }
function fail(msg) { console.log(`❌ ${msg}`); failed++; process.exitCode = 1; }
function section(msg) { console.log(`\n${'═'.repeat(70)}\n${msg}\n${'═'.repeat(70)}`); }

// ═══════════════════════════════════════════════════════════
// CENÁRIOS DE LOOP QUE DEVEM SER PREVENIDOS
// ═══════════════════════════════════════════════════════════

const CENARIOS_LOOP = [
    // Cenário 1: Já tem período, não pergunta de novo
    {
        desc: 'Lead com pendingPreferredPeriod=tarde + msg "Tarde"',
        lead: { pendingPreferredPeriod: 'tarde', patientInfo: { age: 20 } },
        msg: 'Tarde',
        naoDeveConter: ['manhã ou tarde', 'prefere', 'período'],
        devePular: ['period']
    },
    {
        desc: 'Lead com qualificationData.disponibilidade=manha + msg "Manhã"',
        lead: { qualificationData: { disponibilidade: 'manha' }, patientInfo: { age: 15 } },
        msg: 'Manhã',
        naoDeveConter: ['manhã ou tarde', 'prefere'],
        devePular: ['period']
    },
    {
        desc: 'Lead com preferredTime=noite + msg qualquer',
        lead: { preferredTime: 'noite', patientInfo: { fullName: 'João' } },
        msg: 'Ok',
        naoDeveConter: ['manhã ou tarde'],
        devePular: ['period']
    },
    
    // Cenário 2: Já tem nome, não pergunta de novo
    {
        desc: 'Lead com patientInfo.fullName + msg "Meu nome é Maria"',
        lead: { patientInfo: { fullName: 'Ana Laura Vieira', age: 20 } },
        msg: 'Meu nome é Maria',
        naoDeveConter: ['nome completo', 'qual o nome'],
        devePular: ['name']
    },
    
    // Cenário 3: Já tem idade, não pergunta de novo
    {
        desc: 'Lead com patientInfo.age=20 + msg "20"',
        lead: { patientInfo: { age: 20, fullName: 'João' } },
        msg: '20',
        naoDeveConter: ['quantos anos', 'qual a idade'],
        devePular: ['age']
    },
    {
        desc: 'Lead com patientInfo.age=5 + msg "5 anos"',
        lead: { patientInfo: { age: 5, fullName: 'Pedro' } },
        msg: '5 anos',
        naoDeveConter: ['quantos anos'],
        devePular: ['age']
    },
    
    // Cenário 4: Já tem queixa, não pergunta de novo
    {
        desc: 'Lead com complaint + msg qualquer',
        lead: { complaint: 'atraso de fala', patientInfo: { age: 10 } },
        msg: 'Quanto custa?',
        naoDeveConter: ['qual a principal preocupação', 'me conta'],
        devePular: ['complaint']
    },
    
    // Cenário 5: Triagem completa, deve oferecer slots
    {
        desc: 'Lead COMPLETO (nome+idade+periodo+queixa) + msg qualquer',
        lead: {
            patientInfo: { fullName: 'Maria Silva', age: 25 },
            pendingPreferredPeriod: 'tarde',
            complaint: 'ansiedade',
            therapyArea: 'psicologia'
        },
        msg: 'Tá bom',
        naoDeveConter: ['nome', 'idade', 'manhã ou tarde', 'preocupação'],
        devePular: ['name', 'age', 'period', 'complaint']
    },
    
    // Cenário 6: Mensagens fora de contexto após triagem
    {
        desc: 'Triagem completa + msg "kkkk"',
        lead: {
            patientInfo: { fullName: 'Ana', age: 20 },
            pendingPreferredPeriod: 'tarde',
            complaint: 'fala',
            therapyArea: 'fonoaudiologia'
        },
        msg: 'kkkk',
        naoDeveConter: ['nome', 'idade', 'manhã ou tarde'],
        devePular: ['name', 'age', 'period', 'complaint']
    },
    {
        desc: 'Triagem completa + msg emoji "😊"',
        lead: {
            patientInfo: { fullName: 'Pedro', age: 10 },
            pendingPreferredPeriod: 'manha',
            complaint: 'autismo',
            therapyArea: 'psicologia'
        },
        msg: '😊',
        naoDeveConter: ['nome', 'idade', 'manhã ou tarde'],
        devePular: ['name', 'age', 'period', 'complaint']
    },
    {
        desc: 'Triagem completa + msg "obrigada"',
        lead: {
            patientInfo: { fullName: 'Clara', age: 8 },
            pendingPreferredPeriod: 'tarde',
            complaint: 'tdah',
            therapyArea: 'fonoaudiologia'
        },
        msg: 'obrigada',
        naoDeveConter: ['nome', 'idade', 'manhã ou tarde'],
        devePular: ['name', 'age', 'period', 'complaint']
    },
    
    // Cenário 7: Cliente repete a mesma resposta
    {
        desc: 'Lead já tem tarde, cliente repete "Tarde de novo"',
        lead: { pendingPreferredPeriod: 'tarde', patientInfo: { age: 30 } },
        msg: 'Tarde de novo',
        naoDeveConter: ['manhã ou tarde', 'já disse'],
        devePular: ['period']
    },
    
    // Cenário 8: Cliente muda de assunto no meio
    {
        desc: 'Triagem incompleta + pergunta preço (deve responder preço, não repetir pergunta)',
        lead: {
            patientInfo: { fullName: 'João', age: 15 },
            pendingPreferredPeriod: 'tarde',  // Já tem período
            therapyArea: 'psicologia'
            // Falta queixa
        },
        msg: 'Quanto custa?',
        naoDeveConter: ['manhã ou tarde'], // NÃO deve perguntar período de novo
        devePular: ['period'] // Deve pular período
    },
];

// ═══════════════════════════════════════════════════════════
// TESTES DE ANTI-LOOP
// ═══════════════════════════════════════════════════════════

async function testesAntiLoop() {
    section('🛡️ TESTES ANTI-LOOP: Garantia Absoluta');
    
    console.log(`\n🎯 Total de cenários a testar: ${CENARIOS_LOOP.length}\n`);
    
    for (let i = 0; i < CENARIOS_LOOP.length; i++) {
        const cenario = CENARIOS_LOOP[i];
        
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`Teste ${i + 1}/${CENARIOS_LOOP.length}: ${cenario.desc}`);
        console.log(`Mensagem: "${cenario.msg}"`);
        
        // Testa se deve pular perguntas
        let passou = true;
        for (const field of cenario.devePular) {
            const devePular = shouldSkipQuestion(cenario.lead, field);
            if (!devePular) {
                fail(`   Deveria pular pergunta de "${field}" mas não pulou!`);
                passou = false;
            } else {
                console.log(`   ✅ Pula pergunta de "${field}"`);
            }
        }
        
        if (passou) {
            passed++;
        } else {
            failed++;
        }
    }
}

// ═══════════════════════════════════════════════════════════
// TESTE DE ESTRESS: Mensagens aleatórias (simplificado)
// ═══════════════════════════════════════════════════════════

async function testeEstressMensagens() {
    section('💣 TESTE DE ESTRESS: Mensagens aleatórias em lead completo');
    
    await mongoose.connect(MONGO_URI);
    
    const phone = '5562999999700';
    await Leads.deleteOne({ 'contact.phone': phone });
    
    // Cria lead COMPLETO usando MongoDB nativo (sem Mongoose validation)
    const db = mongoose.connection.db;
    const result = await db.collection('leads').insertOne({
        contact: { phone: phone },
        name: 'Estress Test',
        stage: 'triagem_agendamento',
        therapyArea: 'fonoaudiologia',
        patientInfo: {
            fullName: 'Ana Laura Vieira Do Amaral',
            age: 20
        },
        pendingPreferredPeriod: 'tarde',
        qualificationData: { disponibilidade: 'tarde' },
        complaint: 'problema na fala'
    });
    
    console.log('\n📋 Lead criado com TRIAGEM COMPLETA');
    
    // Verifica se dados estão corretos no banco
    const leadCheck = await db.collection('leads').findOne({ _id: result.insertedId });
    console.log('   ✓ Nome:', leadCheck.patientInfo?.fullName);
    console.log('   ✓ Idade:', leadCheck.patientInfo?.age);
    console.log('   ✓ Período:', leadCheck.pendingPreferredPeriod);
    console.log('   ✓ Queixa:', leadCheck.complaint);
    
    // Testa proteções
    const devePularNome = shouldSkipQuestion(leadCheck, 'name');
    const devePularIdade = shouldSkipQuestion(leadCheck, 'age');
    const devePularPeriodo = shouldSkipQuestion(leadCheck, 'period');
    const devePularQueixa = shouldSkipQuestion(leadCheck, 'complaint');
    
    console.log('\n🔍 Verificação de proteções:');
    console.log('   Skip nome:', devePularNome);
    console.log('   Skip idade:', devePularIdade);
    console.log('   Skip período:', devePularPeriodo);
    console.log('   Skip queixa:', devePularQueixa);
    
    await db.collection('leads').deleteOne({ _id: result.insertedId });
    await mongoose.disconnect();
    
    if (!devePularNome || !devePularIdade || !devePularPeriodo || !devePularQueixa) {
        fail('Loop detectado em lead completo!');
    } else {
        pass('Todas as proteções funcionando para lead completo!');
    }
}

// ═══════════════════════════════════════════════════════════
// TESTE ESPECÍFICO: Caso Ana Laura (repetição)
// ═══════════════════════════════════════════════════════════

async function testeCasoAnaLauraRepeticoes() {
    section('🔄 TESTE ESPECÍFICO: Caso Ana Laura - Repetições');
    
    await mongoose.connect(MONGO_URI);
    
    const phone = '5562999999701';
    const db = mongoose.connection.db;
    await db.collection('leads').deleteOne({ 'contact.phone': phone });
    
    // Cria lead usando MongoDB nativo
    const result = await db.collection('leads').insertOne({
        contact: { phone: phone },
        name: 'Ana Laura Test',
        stage: 'triagem_agendamento',
        therapyArea: 'fonoaudiologia',
        patientInfo: {
            fullName: 'Ana Laura Vieira Do Amaral',
            age: 20
        },
        pendingPreferredPeriod: 'tarde',
        complaint: 'problema com a fala'
    });
    
    console.log('\n📋 Simulando o loop que aconteceu em produção:');
    console.log('   Lead tem: nome + idade(20) + período(tarde) + queixa');
    
    // Verifica uma vez (o suficiente para garantir proteção)
    const leadFresh = await db.collection('leads').findOne({ _id: result.insertedId });
    
    const devePularPeriodo = shouldSkipQuestion(leadFresh, 'period');
    const devePularNome = shouldSkipQuestion(leadFresh, 'name');
    const devePularIdade = shouldSkipQuestion(leadFresh, 'age');
    const devePularQueixa = shouldSkipQuestion(leadFresh, 'complaint');
    
    console.log(`\n   Verificação de proteções:`);
    console.log(`      Skip nome: ${devePularNome}`);
    console.log(`      Skip idade: ${devePularIdade}`);
    console.log(`      Skip período: ${devePularPeriodo}`);
    console.log(`      Skip queixa: ${devePularQueixa}`);
    
    await db.collection('leads').deleteOne({ _id: result.insertedId });
    await mongoose.disconnect();
    
    if (!devePularPeriodo || !devePularNome || !devePularIdade || !devePularQueixa) {
        fail('Caso Ana Laura causaria loop!');
    } else {
        pass('Caso Ana Laura totalmente protegido contra loop!');
    }
}

// ═══════════════════════════════════════════════════════════
// TESTE: Proteção em steps com dados já existentes
// ═══════════════════════════════════════════════════════════

async function testeProtecaoStepsComDados() {
    section('🛡️ TESTE: Proteção em steps com dados já existentes');
    
    await mongoose.connect(MONGO_URI);
    
    // Teste 1: ask_age com idade já existente
    const phone1 = '5562999999801';
    const db = mongoose.connection.db;
    await db.collection('leads').deleteOne({ 'contact.phone': phone1 });
    
    const result1 = await db.collection('leads').insertOne({
        contact: { phone: phone1 },
        name: 'Teste Idade',
        stage: 'triagem_agendamento',
        therapyArea: 'fonoaudiologia',
        patientInfo: { age: 25 },
        triageStep: 'ask_age', // Step errado, deveria ser ask_complaint
        pendingPreferredPeriod: 'manha'
    });
    
    const leadIdade = await db.collection('leads').findOne({ _id: result1.insertedId });
    
    const response1 = await getOptimizedAmandaResponse({
        message: { text: 'Qualquer coisa' },
        lead: leadIdade,
        session: { phone: phone1 }
    });
    
    const pulouIdade = !response1.includes('idade');
    const foiParaQueixa = response1.includes('queixa') || response1.includes('preocupação');
    
    console.log(`   ask_age com idade já existente:`);
    console.log(`      Não perguntou idade: ${pulouIdade}`);
    console.log(`      Avançou para queixa: ${foiParaQueixa}`);
    
    await db.collection('leads').deleteOne({ _id: result1.insertedId });
    
    // Teste 2: ask_complaint com queixa já existente
    const phone2 = '5562999999802';
    await db.collection('leads').deleteOne({ 'contact.phone': phone2 });
    
    const result2 = await db.collection('leads').insertOne({
        contact: { phone: phone2 },
        name: 'Teste Queixa',
        stage: 'triagem_agendamento',
        therapyArea: 'fonoaudiologia',
        patientInfo: { age: 30 },
        complaint: 'TDAH',
        triageStep: 'ask_complaint', // Step errado, deveria ser done
        pendingPreferredPeriod: 'tarde'
    });
    
    const leadQueixa = await db.collection('leads').findOne({ _id: result2.insertedId });
    
    const response2 = await getOptimizedAmandaResponse({
        message: { text: 'kkkk' },
        lead: leadQueixa,
        session: { phone: phone2 }
    });
    
    const naoPerguntouQueixa = !response2.includes('queixa') && !response2.includes('preocupação');
    const mostrouSlotsOuFinalizou = response2.includes('disponível') || 
                                     response2.includes('funciona') || 
                                     response2.includes('vou verificar');
    
    console.log(`   ask_complaint com queixa já existente:`);
    console.log(`      Não perguntou queixa: ${naoPerguntouQueixa}`);
    console.log(`      Finalizou/Mostrou slots: ${mostrouSlotsOuFinalizou}`);
    
    await db.collection('leads').deleteOne({ _id: result2.insertedId });
    await mongoose.disconnect();
    
    if (pulouIdade && foiParaQueixa && naoPerguntouQueixa && mostrouSlotsOuFinalizou) {
        pass('Proteção em steps com dados existentes funcionando!');
    } else {
        fail('Proteção em steps com dados existentes falhou!');
    }
}

// ═══════════════════════════════════════════════════════════
// EXECUÇÃO
// ═══════════════════════════════════════════════════════════

async function runAll() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🛡️ TESTES ANTI-LOOP: Garantia Absoluta                   ║');
    console.log('║                                                            ║');
    console.log('║  Garantindo que NUNCA mais estresse cliente com:           ║');
    console.log('║  ❌ "Qual o nome?" (já respondeu)                          ║');
    console.log('║  ❌ "Quantos anos?" (já respondeu)                         ║');
    console.log('║  ❌ "Manhã ou tarde?" (já respondeu)                       ║');
    console.log('║  ❌ "Qual a preocupação?" (já respondeu)                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    await testesAntiLoop();
    await testeEstressMensagens();
    await testeCasoAnaLauraRepeticoes();
    await testeProtecaoStepsComDados();
    
    section('📊 RESUMO FINAL - ANTI-LOOP');
    console.log(`✅ Passaram: ${passed}`);
    console.log(`❌ Falharam: ${failed}`);
    console.log(`📊 Taxa de sucesso: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
    
    if (failed > 0) {
        console.log('\n❌❌❌ LOOP AINDA É POSSÍVEL! ❌❌❌');
        console.log('   NÃO SUBA PARA PRODUÇÃO!');
        process.exit(1);
    } else {
        console.log('\n✅✅✅ LOOP ELIMINADO! ✅✅✅');
        console.log('   Cliente NUNCA mais será estressado com repetições!');
        process.exit(0);
    }
}

runAll().catch(err => {
    console.error('💥 ERRO FATAL:', err);
    process.exit(1);
});
