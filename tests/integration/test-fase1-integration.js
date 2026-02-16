#!/usr/bin/env node
/**
 * 🧪 TESTE DE INTEGRAÇÃO - FASE 1
 *
 * Valida que os detectores contextuais estão funcionando
 * corretamente no fluxo completo do orchestrator.
 */

import { detectWithContext } from '../../detectors/DetectorAdapter.js';
import { enforce } from '../../services/EnforcementLayer.js';

console.log('🧪 TESTE DE INTEGRAÇÃO - FASE 1\n');
console.log('='.repeat(60));

let passed = 0;
let total = 0;

function test(name, fn) {
    total++;
    try {
        fn();
        passed++;
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
// CENÁRIO 1: Lead pergunta sobre Unimed
// =========================================================================
console.log('\n📋 CENÁRIO 1: Lead pergunta "Aceitam Unimed?"\n' + '-'.repeat(60));

test('Detecta plano específico (Unimed)', () => {
    const flags = detectWithContext("Aceitam Unimed?", {}, {});

    assert(flags.asksPlans === true, 'Flag legacy asksPlans deve estar presente');
    assert(flags._insurance !== undefined, '_insurance deve estar presente');
    assert(flags._insurance.plan === 'unimed', 'Plano deve ser unimed');
    assert(flags._insurance.isSpecific === true, 'Deve ser específico');
    assert(flags.mentionsUnimed === true, 'Flag mentionsUnimed deve estar presente');

    console.log('   → Flag legacy: asksPlans =', flags.asksPlans);
    console.log('   → Plano detectado:', flags._insurance.plan);
    console.log('   → Wisdom key:', flags._insurance.wisdomKey);
});

test('Enforcement valida resposta sobre Unimed', () => {
    const response = "Com a Unimed emitimos nota fiscal pra reembolso 💚";
    const flags = detectWithContext("Aceitam Unimed?", {}, {});

    const result = enforce(response, { flags }, { strictMode: false });

    assert(result.validation.isValid === true, 'Resposta deve ser válida');
    console.log('   → Resposta válida:', result.validation.isValid);
    console.log('   → Score:', (result.validation.score * 100).toFixed(0) + '%');
});

// =========================================================================
// CENÁRIO 2: Lead confirma horário
// =========================================================================
console.log('\n📋 CENÁRIO 2: Amanda pergunta "Confirma segunda às 14h?", Lead responde "sim"\n' + '-'.repeat(60));

test('Detecta confirmação contextual de slot', () => {
    const flags = detectWithContext("sim",
        { stage: 'triagem_agendamento' },
        {
            conversationHistory: [
                { role: 'assistant', content: 'Confirma segunda às 14h?' }
            ]
        }
    );

    assert(flags.isConfirmation === true, 'Flag legacy isConfirmation deve estar presente');
    assert(flags._confirmation !== undefined, '_confirmation deve estar presente');
    assert(flags._confirmation.semanticMeaning === 'accept_slot', 'Deve inferir accept_slot');
    assert(flags.confirmsScheduling === true, 'confirmsScheduling deve ser true');

    console.log('   → Significado inferido:', flags._confirmation.semanticMeaning);
    console.log('   → Confiança:', (flags._confirmation.confidence * 100).toFixed(0) + '%');
    console.log('   → Flags extras: confirmsScheduling =', flags.confirmsScheduling);
});

// =========================================================================
// CENÁRIO 3: Lead confirma preço
// =========================================================================
console.log('\n📋 CENÁRIO 3: Amanda fala "O valor é R$200", Lead responde "ok"\n' + '-'.repeat(60));

test('Detecta confirmação contextual de preço', () => {
    const flags = detectWithContext("ok",
        { stage: 'negociacao' },
        {
            conversationHistory: [
                { role: 'assistant', content: 'A avaliação inicial é R$200. Tudo bem?' }
            ]
        }
    );

    assert(flags._confirmation.semanticMeaning === 'accept_price', 'Deve inferir accept_price');
    assert(flags.acceptsPrice === true, 'acceptsPrice deve ser true');

    console.log('   → Significado inferido:', flags._confirmation.semanticMeaning);
    console.log('   → Flags extras: acceptsPrice =', flags.acceptsPrice);
});

// =========================================================================
// CENÁRIO 4: Enforcement de resposta de preço
// =========================================================================
console.log('\n📋 CENÁRIO 4: Validação estrutural de resposta de preço\n' + '-'.repeat(60));

test('Enforcement aceita resposta válida de preço', () => {
    const response = "A avaliação inicial é R$200 💚";
    const flags = { asksPrice: true };

    const result = enforce(response, { flags }, { strictMode: false });

    assert(result.validation.isValid === true, 'Deve ser válida');
    console.log('   → Validação:', result.validation.isValid ? 'PASSOU ✓' : 'FALHOU ✗');
    console.log('   → Score:', (result.validation.score * 100).toFixed(0) + '%');
});

test('Enforcement rejeita resposta sem valor', () => {
    const response = "A avaliação é super em conta!";
    const flags = { asksPrice: true };

    const result = enforce(response, { flags }, { strictMode: false });

    assert(result.validation.isValid === false, 'Deve ser inválida');
    assert(result.validation.violations.length > 0, 'Deve ter violações');
    console.log('   → Validação:', result.validation.isValid ? 'PASSOU ✓' : 'FALHOU ✗');
    console.log('   → Violações:', result.validation.violations.length);
});

test('Enforcement aceita variações de linguagem', () => {
    const responses = [
        "R$200 é o investimento inicial 💚",
        "A gente cobra R$ 200 pra primeira consulta",
        "O valor da avaliação fica em R$200,00"
    ];

    responses.forEach(response => {
        const flags = { asksPrice: true };
        const result = enforce(response, { flags }, { strictMode: false });
        assert(result.validation.isValid === true, `"${response}" deve ser válida`);
    });

    console.log('   → Todas as 3 variações passaram ✓');
});

// =========================================================================
// CENÁRIO 5: Fluxo completo - Lead pergunta Unimed e confirma
// =========================================================================
console.log('\n📋 CENÁRIO 5: Fluxo completo - Unimed + Confirmação\n' + '-'.repeat(60));

test('Fluxo: Pergunta Unimed → Amanda responde → Lead confirma', () => {
    // 1. Lead pergunta
    const flags1 = detectWithContext("Aceitam Unimed?", {}, {});
    assert(flags1._insurance.plan === 'unimed', 'Passo 1: Deve detectar Unimed');
    console.log('   1️⃣ Lead pergunta "Aceitam Unimed?" → Detectado:', flags1._insurance.plan);

    // 2. Amanda responde
    const amandaResponse = "Com a Unimed emitimos nota fiscal pra reembolso 💚";
    const enforcement = enforce(amandaResponse, { flags: flags1 }, { strictMode: false });
    assert(enforcement.validation.isValid === true, 'Passo 2: Resposta deve ser válida');
    console.log('   2️⃣ Amanda: "' + amandaResponse.substring(0, 40) + '..." → Válido ✓');

    // 3. Lead confirma
    const flags2 = detectWithContext("ok",
        { stage: 'general' },
        {
            conversationHistory: [
                { role: 'user', content: 'Aceitam Unimed?' },
                { role: 'assistant', content: amandaResponse },
                { role: 'user', content: 'ok' }
            ]
        }
    );
    assert(flags2.isConfirmation === true, 'Passo 3: Deve detectar confirmação');
    console.log('   3️⃣ Lead: "ok" → Confirmação detectada ✓');

    console.log('   ✅ Fluxo completo funcionando!');
});

// =========================================================================
// RESULTADOS FINAIS
// =========================================================================
console.log('\n' + '='.repeat(60));
console.log(`\n📊 RESULTADOS DA INTEGRAÇÃO\n`);
console.log(`Total de testes: ${total}`);
console.log(`✅ Passou: ${passed}`);
console.log(`❌ Falhou: ${total - passed}`);
console.log(`📈 Taxa de sucesso: ${((passed / total) * 100).toFixed(1)}%`);

if (passed === total) {
    console.log('\n🎉 INTEGRAÇÃO FASE 1 FUNCIONANDO PERFEITAMENTE!\n');
    console.log('✅ Detectores contextuais integrados');
    console.log('✅ Enforcement layer validando');
    console.log('✅ Fluxos completos funcionando');
    console.log('\n🚀 PRONTO PARA PRÓXIMA FASE!\n');
    process.exit(0);
} else {
    console.log('\n⚠️ ALGUNS TESTES DE INTEGRAÇÃO FALHARAM.\n');
    process.exit(1);
}
