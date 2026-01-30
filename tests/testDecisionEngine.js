/**
 * 🧪 Teste Unitário do DecisionEngine
 * Não precisa de MongoDB - testa só a lógica
 */

import { decisionEngine } from '../services/intelligence/DecisionEngine.js';

// Test helper
function test(name, fn) {
    try {
        const result = fn();
        if (result.success) {
            console.log(`✅ ${name}`);
        } else {
            console.log(`❌ ${name}: ${result.error}`);
        }
        return result.success;
    } catch (err) {
        console.log(`❌ ${name}: ${err.message}`);
        return false;
    }
}

// Assert helpers
function assertEquals(actual, expected, field) {
    if (actual !== expected) {
        return { 
            success: false, 
            error: `Expected ${field}='${expected}', got '${actual}'` 
        };
    }
    return { success: true };
}

// Run all tests
function runTests() {
    console.log('🧪 TESTES DO DECISION ENGINE\n');
    
    let passed = 0;
    let total = 0;

    // Test 1: Fluxo completo - vai para booking quando tem tudo
    total++;
    if (test('Deve ir para booking quando tem todos os dados', () => {
        const result = decisionEngine({
            analysis: { intent: 'scheduling' },
            missing: {
                needsTherapy: false,
                needsComplaint: false,
                needsAge: false,
                needsPeriod: false,
                needsSlot: true
            },
            urgency: 1,
            bookingContext: {},
            clinicalRules: {}
        });
        return assertEquals(result.handler, 'bookingHandler', 'handler');
    })) passed++;

    // Test 2: Precisa de terapia primeiro
    total++;
    if (test('Deve pedir terapia quando não tem', () => {
        const result = decisionEngine({
            analysis: { intent: 'scheduling' },
            missing: {
                needsTherapy: true,
                needsComplaint: true,
                needsAge: true,
                needsPeriod: true
            },
            urgency: 1,
            bookingContext: {},
            clinicalRules: {}
        });
        return assertEquals(result.action, 'ask_therapy', 'action');
    })) passed++;

    // Test 3: Drive para agendamento (interesse implícito)
    total++;
    if (test('Deve detectar interesse implícito e ir para booking', () => {
        const result = decisionEngine({
            analysis: {
                intent: 'general_info', // não é scheduling
                extractedInfo: { queixa: 'fala pouco' }
            },
            missing: {
                needsTherapy: false,  // tem terapia
                needsComplaint: false, // tem queixa
                needsAge: true,        // falta idade
                needsPeriod: true
            },
            urgency: 1,
            bookingContext: {},
            clinicalRules: {},
            context: {}
        });
        // Deve ir para ask_age (coletar o que falta)
        return assertEquals(result.action, 'ask_age', 'action');
    })) passed++;

    // Test 4: Interrupção - preço durante agendamento
    total++;
    if (test('Deve preservar estado em interrupção de preço', () => {
        const result = decisionEngine({
            analysis: { intent: 'price' },
            missing: {
                needsTherapy: false,
                needsComplaint: false,
                needsAge: true, // estava esperando idade
                currentAwaiting: 'age'
            },
            urgency: 1,
            bookingContext: {
                slots: null,
                chosenSlot: null
            },
            clinicalRules: {},
            context: { messageCount: 5 }
        });
        return assertEquals(result.preserveBookingState, true, 'preserveBookingState');
    })) passed++;

    // Test 5: Coleta de queixa
    total++;
    if (test('Deve coletar queixa quando tem terapia mas falta queixa', () => {
        const result = decisionEngine({
            analysis: { intent: 'scheduling' },
            missing: {
                needsTherapy: false,
                needsComplaint: true,
                needsAge: true
            },
            urgency: 1,
            bookingContext: {},
            clinicalRules: {}
        });
        return assertEquals(result.handler, 'complaintCollectionHandler', 'handler');
    })) passed++;

    // Test 6: Preço
    total++;
    if (test('Deve ir para productHandler quando pergunta preço', () => {
        const result = decisionEngine({
            analysis: { intent: 'price' },
            missing: { needsTherapy: true },
            urgency: 1,
            bookingContext: {},
            clinicalRules: {}
        });
        return assertEquals(result.handler, 'productHandler', 'handler');
    })) passed++;

    // Summary
    console.log(`\n${'='.repeat(40)}`);
    console.log(`📊 RESULTADO: ${passed}/${total} testes passaram`);
    console.log('='.repeat(40));
    
    return passed === total;
}

// Run
const success = runTests();
process.exit(success ? 0 : 1);
