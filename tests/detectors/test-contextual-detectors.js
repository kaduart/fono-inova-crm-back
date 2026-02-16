#!/usr/bin/env node
/**
 * 🧪 TESTE DE DETECTORES CONTEXTUAIS
 *
 * Valida a implementação da Fase 1:
 * - ConfirmationDetector
 * - InsuranceDetector
 * - DetectorAdapter
 * - EnforcementLayer
 */

import ConfirmationDetector from '../../detectors/ConfirmationDetector.js';
import InsuranceDetector from '../../detectors/InsuranceDetector.js';
import { detectWithContext } from '../../detectors/DetectorAdapter.js';
import { enforce, validateResponse } from '../../services/EnforcementLayer.js';

console.log('🧪 TESTE DE DETECTORES CONTEXTUAIS - FASE 1\n');
console.log('='.repeat(60));

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
    totalTests++;
    try {
        fn();
        passedTests++;
        console.log(`✅ ${name}`);
    } catch (e) {
        console.error(`❌ ${name}`);
        console.error(`   ${e.message}`);
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

// =========================================================================
// 1️⃣ CONFIRMATION DETECTOR
// =========================================================================
console.log('\n📊 1. ConfirmationDetector\n' + '-'.repeat(60));

test('Detecta "sim" como confirmação', () => {
    const result = ConfirmationDetector.detect("sim");
    assert(result?.detected === true, 'Deve detectar');
    assert(result?.type === 'confirmation', 'Tipo deve ser confirmation');
});

test('Detecta "ok" como confirmação', () => {
    const result = ConfirmationDetector.detect("ok");
    assert(result?.detected === true, 'Deve detectar');
    assert(result?.confirmationType === 'short', 'Tipo deve ser short');
});

test('Infere accept_slot com contexto de scheduling', () => {
    const result = ConfirmationDetector.detect("sim", {
        lastBotMessage: "Confirma segunda às 14h?",
        stage: "scheduling"
    });
    assert(result?.semanticMeaning === 'accept_slot', `Esperado: accept_slot, Obtido: ${result?.semanticMeaning}`);
    assert(result?.confidence > 0.7, 'Confiança deve ser > 0.7');
});

test('Infere accept_price com contexto de pricing', () => {
    const result = ConfirmationDetector.detect("ok", {
        lastBotMessage: "O valor é R$200. Tudo bem?",
        stage: "pricing"
    });
    assert(result?.semanticMeaning === 'accept_price', `Esperado: accept_price, Obtido: ${result?.semanticMeaning}`);
});

test('Marca requiresValidation se confiança baixa', () => {
    const result = ConfirmationDetector.detect("sim", {
        // Sem contexto
    });
    assert(result?.confidence < 0.7, 'Confiança deve ser < 0.7 sem contexto');
    assert(result?.requiresValidation === true, 'Deve requerer validação');
});

test('Rejeita negações', () => {
    const result = ConfirmationDetector.detect("não");
    assert(result?.detected === false, 'Não deve detectar negação como confirmação');
});

test('Detecta confirmação explícita', () => {
    const result = ConfirmationDetector.detect("confirmo sim");
    assert(result?.confirmationType === 'explicit', 'Tipo deve ser explicit');
    assert(result?.confidence > 0.8, 'Confirmação explícita deve ter alta confiança');
});

// =========================================================================
// 2️⃣ INSURANCE DETECTOR
// =========================================================================
console.log('\n🏥 2. InsuranceDetector\n' + '-'.repeat(60));

test('Detecta Unimed específico', () => {
    const result = InsuranceDetector.detect("Aceitam Unimed?");
    assert(result?.detected === true, 'Deve detectar');
    assert(result?.plan === 'unimed', `Esperado: unimed, Obtido: ${result?.plan}`);
    assert(result?.isSpecific === true, 'Deve ser específico');
    assert(result?.wisdomKey === 'unimed', 'wisdomKey deve ser unimed');
});

test('Detecta Ipasgo específico', () => {
    const result = InsuranceDetector.detect("Tem Ipasgo?");
    assert(result?.plan === 'ipasgo', `Esperado: ipasgo, Obtido: ${result?.plan}`);
    assert(result?.isSpecific === true, 'Deve ser específico');
});

test('Detecta plano genérico', () => {
    const result = InsuranceDetector.detect("Aceitam convênio?");
    assert(result?.detected === true, 'Deve detectar');
    assert(result?.plan === 'generic', 'Deve ser genérico');
    assert(result?.isSpecific === false, 'Não deve ser específico');
});

test('Classifica intenção como question', () => {
    const result = InsuranceDetector.detect("Aceitam Unimed?");
    assert(result?.intentType === 'question', `Esperado: question, Obtido: ${result?.intentType}`);
});

test('Classifica intenção como statement', () => {
    const result = InsuranceDetector.detect("Eu tenho Unimed");
    assert(result?.intentType === 'statement', `Esperado: statement, Obtido: ${result?.intentType}`);
});

test('Alta confiança para plano específico', () => {
    const result = InsuranceDetector.detect("Aceitam Unimed?");
    assert(result?.confidence > 0.8, `Confiança deve ser > 0.8, obtido: ${result?.confidence}`);
});

test('Não detecta se não menciona plano', () => {
    const result = InsuranceDetector.detect("Olá, bom dia!");
    assert(result === null, 'Não deve detectar');
});

// =========================================================================
// 3️⃣ DETECTOR ADAPTER
// =========================================================================
console.log('\n🔌 3. DetectorAdapter\n' + '-'.repeat(60));

test('Mantém compatibilidade com flags legacy', () => {
    const flags = detectWithContext("Aceitam Unimed?", {}, {});
    assert(flags.asksPlans === true, 'Flag legacy asksPlans deve estar presente');
});

test('Adiciona dados contextuais _insurance', () => {
    const flags = detectWithContext("Aceitam Unimed?", {}, {});
    assert(flags._insurance !== undefined, '_insurance deve estar presente');
    assert(flags._insurance?.plan === 'unimed', 'Plano deve ser unimed');
});

test('Adiciona dados contextuais _confirmation', () => {
    const flags = detectWithContext("sim", {}, {
        conversationHistory: [
            { role: 'assistant', content: 'Confirma segunda às 14h?' },
            { role: 'user', content: 'sim' }
        ]
    });
    assert(flags.isConfirmation === true, 'Flag legacy isConfirmation deve estar presente');
    assert(flags._confirmation !== undefined, '_confirmation deve estar presente');
});

test('Adiciona flag específica mentionsUnimed', () => {
    const flags = detectWithContext("Aceitam Unimed?", {}, {});
    assert(flags.mentionsUnimed === true, 'mentionsUnimed deve ser true');
});

test('Adiciona flag confirmsScheduling quando accept_slot', () => {
    const flags = detectWithContext("sim", { stage: 'triagem_agendamento' }, {
        conversationHistory: [
            { role: 'assistant', content: 'Confirma segunda às 14h?' }
        ]
    });
    console.log('   DEBUG: semanticMeaning =', flags._confirmation?.semanticMeaning);
    console.log('   DEBUG: confirmsScheduling =', flags.confirmsScheduling);
    assert(flags.confirmsScheduling === true, 'confirmsScheduling deve ser true');
});

test('Adiciona metadados _meta', () => {
    const flags = detectWithContext("Olá", {}, {});
    assert(flags._meta !== undefined, '_meta deve estar presente');
    assert(flags._meta?.timestamp !== undefined, 'timestamp deve estar presente');
});

// =========================================================================
// 4️⃣ ENFORCEMENT LAYER
// =========================================================================
console.log('\n🛡️ 4. EnforcementLayer\n' + '-'.repeat(60));

test('Valida resposta de preço válida', () => {
    const validation = validateResponse("A avaliação inicial é R$200 💚", {
        flags: { asksPrice: true }
    });
    assert(validation.isValid === true, 'Deve ser válida');
    assert(validation.violations.length === 0, 'Não deve ter violações');
});

test('Detecta violação em resposta de preço sem valor', () => {
    const validation = validateResponse("A avaliação é super em conta!", {
        flags: { asksPrice: true }
    });
    assert(validation.isValid === false, 'Deve ser inválida');
    assert(validation.violations.length > 0, 'Deve ter violações');
    assert(validation.violations[0].rule === 'Resposta de Preço', 'Violação deve ser de Preço');
});

test('Valida resposta de plano válida', () => {
    const validation = validateResponse("Com a Unimed emitimos nota fiscal pra reembolso 💚", {
        flags: {
            asksPlans: true,
            _insurance: { plan: 'unimed', detected: true }
        }
    });
    assert(validation.isValid === true, 'Deve ser válida');
});

test('Detecta violação em resposta de plano sem mencionar aceitação', () => {
    const validation = validateResponse("Trabalhamos com vários planos!", {
        flags: { asksPlans: true }
    });
    assert(validation.isValid === false, 'Deve ser inválida');
    assert(validation.violations.some(v => v.validator === 'menciona_aceitacao'), 'Deve ter violação de menção de aceitação');
});

test('Enforcement em modo não-strict não força fallback', () => {
    const result = enforce("Resposta inválida", {
        flags: { asksPrice: true }
    }, {
        strictMode: false
    });
    assert(result.wasEnforced === false, 'Não deve aplicar fallback em modo não-strict');
    assert(result.response === "Resposta inválida", 'Deve retornar resposta original');
});

test('Calcula score corretamente', () => {
    const validation = validateResponse("A avaliação inicial é R$200 💚", {
        flags: { asksPrice: true }
    });
    assert(validation.score === 1.0, `Score deve ser 1.0, obtido: ${validation.score}`);
    assert(validation.stats.totalRulesChecked > 0, 'Deve ter verificado regras');
});

test('Não valida regras não aplicáveis', () => {
    const validation = validateResponse("Olá, tudo bem?", {
        flags: {}  // Sem flags que ativem regras
    });
    assert(validation.stats.totalRulesChecked === 0, 'Não deve verificar regras se não aplicável');
});

// =========================================================================
// 📊 RESULTADOS
// =========================================================================
console.log('\n' + '='.repeat(60));
console.log(`\n📊 RESULTADOS FINAIS\n`);
console.log(`Total de testes: ${totalTests}`);
console.log(`✅ Passou: ${passedTests}`);
console.log(`❌ Falhou: ${totalTests - passedTests}`);
console.log(`📈 Taxa de sucesso: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

if (passedTests === totalTests) {
    console.log('\n🎉 TODOS OS TESTES PASSARAM! FASE 1 IMPLEMENTADA CORRETAMENTE!\n');
    process.exit(0);
} else {
    console.log('\n⚠️ ALGUNS TESTES FALHARAM. REVISAR IMPLEMENTAÇÃO.\n');
    process.exit(1);
}
