#!/usr/bin/env node
/**
 * 🧪 TESTES CRÍTICOS: Proteção contra corrupção de dados
 * 
 * Testa:
 * 1. safeAgeUpdate - Protege downgrade de idade
 * 2. Prevenção de loop na triagem
 * 3. Hard stop do fluxo legado
 */

import { safeAgeUpdate, hasAgeContext, shouldSkipQuestion } from '../../utils/safeDataUpdate.js';
import { extractAgeFromText } from '../../utils/patientDataExtractor.js';

function pass(msg) { console.log(`✅ ${msg}`); }
function fail(msg) { console.log(`❌ ${msg}`); process.exitCode = 1; }
function section(msg) { console.log(`\n${'═'.repeat(60)}\n${msg}\n${'═'.repeat(60)}`); }

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
    try {
        fn();
        pass(name);
        testsPassed++;
    } catch (e) {
        fail(`${name}: ${e.message}`);
        testsFailed++;
    }
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: esperado ${expected}, recebido ${actual}`);
    }
}

// ═══════════════════════════════════════════════════════════
// TESTES SAFE AGE UPDATE
// ═══════════════════════════════════════════════════════════

section('🛡️ SafeAgeUpdate - Proteção de Idade');

test('Não permite downgrade de 20 para 1', () => {
    const result = safeAgeUpdate(20, 1, "minha filha tem 1 sessão por semana");
    assertEqual(result.age, 20, 'Deve manter idade 20');
    assertEqual(result.reason, 'reject_downgrade', 'Deve indicar downgrade rejeitado');
});

test('Não permite downgrade de 20 para 5', () => {
    const result = safeAgeUpdate(20, 5, "ela tem 5 anos");
    assertEqual(result.age, 20, 'Deve manter idade 20 (>10 para <5)');
    // Pode ser reject_downgrade OU reject_large_diff - ambos são válidos
    const validReasons = ['reject_downgrade', 'reject_large_diff'];
    if (!validReasons.includes(result.reason)) {
        throw new Error(`Razão ${result.reason} não é válida. Esperado: reject_downgrade ou reject_large_diff`);
    }
});

test('Permite atualização válida quando não existe idade', () => {
    const result = safeAgeUpdate(null, 20, "minha filha tem 20 anos");
    assertEqual(result.age, 20, 'Deve aceitar nova idade');
    assertEqual(result.reason, 'first_time', 'Deve indicar primeira vez');
});

test('Rejeita diferença maior que 50%', () => {
    const result = safeAgeUpdate(10, 3, "ele tem 3 anos");
    assertEqual(result.age, 10, 'Deve manter idade 10 (diff > 50%)');
    assertEqual(result.reason, 'reject_large_diff', 'Deve indicar diferença grande');
});

test('Aceita atualização menor com contexto explícito de anos', () => {
    const result = safeAgeUpdate(8, 7, "na verdade ele tem 7 anos");
    assertEqual(result.age, 7, 'Deve aceitar correção com contexto');
    assertEqual(result.reason, 'accepted', 'Deve aceitar com contexto');
});

test('Rejeita downgrade sem contexto de anos', () => {
    const result = safeAgeUpdate(8, 7, "ele tem 7");
    assertEqual(result.age, 8, 'Deve rejeitar sem contexto anos');
    assertEqual(result.reason, 'reject_no_context', 'Deve indicar falta de contexto');
});

test('Mantém idade quando não há nova idade', () => {
    const result = safeAgeUpdate(15, null, "qual o valor?");
    assertEqual(result.age, 15, 'Deve manter idade atual');
    assertEqual(result.reason, 'no_new_data', 'Deve indicar sem novos dados');
});

// ═══════════════════════════════════════════════════════════
// TESTES EXTRACT AGE COM CONTEXTO
// ═══════════════════════════════════════════════════════════

section('🔍 ExtractAgeFromText - Contexto Obrigatório');

test('Extrai idade com contexto de anos', () => {
    const result = extractAgeFromText("minha filha tem 20 anos");
    assertEqual(result.age, 20, 'Deve extrair 20 anos');
});

test('NÃO extrai número solto sem contexto de idade', () => {
    const result = extractAgeFromText("ela faz 1 sessão por semana");
    // O novo regex não deve pegar "1" sem contexto de idade
    assertEqual(result === null || result.age !== 1, true, 'Não deve extrair 1 sem contexto');
});

test('Extrai idade com "tem" + número isolado', () => {
    const result = extractAgeFromText("tem 20");
    // Com "tem" é contexto válido
    assertEqual(result !== null && result.age === 20, true, 'Deve extrair com "tem"');
});

test('Extrai idade com "de X anos"', () => {
    const result = extractAgeFromText("meu filho de 5 anos");
    assertEqual(result.age, 5, 'Deve extrair 5 anos');
});

// ═══════════════════════════════════════════════════════════
// TESTES SKIP QUESTION
// ═══════════════════════════════════════════════════════════

section('⏭️ ShouldSkipQuestion - Prevenção de Loop');

test('Pula pergunta de período se já tem pendingPreferredPeriod', () => {
    const lead = { pendingPreferredPeriod: 'tarde' };
    const result = shouldSkipQuestion(lead, 'period');
    assertEqual(result, true, 'Deve pular pergunta de período');
});

test('Pula pergunta de período se tem qualificationData.disponibilidade', () => {
    const lead = { qualificationData: { disponibilidade: 'manha' } };
    const result = shouldSkipQuestion(lead, 'period');
    assertEqual(result, true, 'Deve pular com disponibilidade');
});

test('NÃO pula pergunta se não tem dados', () => {
    const lead = {};
    const result = shouldSkipQuestion(lead, 'period');
    assertEqual(result, false, 'Não deve pular sem dados');
});

test('Pula pergunta de idade se já tem patientInfo.age', () => {
    const lead = { patientInfo: { age: 20 } };
    const result = shouldSkipQuestion(lead, 'age');
    assertEqual(result, true, 'Deve pular pergunta de idade');
});

test('Pula pergunta de nome se já tem fullName', () => {
    const lead = { patientInfo: { fullName: 'Ana Laura' } };
    const result = shouldSkipQuestion(lead, 'name');
    assertEqual(result, true, 'Deve pular pergunta de nome');
});

// ═══════════════════════════════════════════════════════════
// RESUMO
// ═══════════════════════════════════════════════════════════

section('📊 RESUMO DOS TESTES');
console.log(`✅ Passaram: ${testsPassed}`);
console.log(`❌ Falharam: ${testsFailed}`);
console.log(`📈 Total: ${testsPassed + testsFailed}`);

if (testsFailed > 0) {
    console.log('\n❌ TESTES FALHARAM - Corrija antes de subir para produção!');
    process.exit(1);
} else {
    console.log('\n✅ TODOS OS TESTES PASSARAM - Sistema protegido contra corrupção!');
    process.exit(0);
}
