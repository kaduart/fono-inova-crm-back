/**
 * 🧪 Teste Unitário do DecisionEngine
 * Não precisa de MongoDB - testa só a lógica
 */

import { decisionEngine } from '../services/intelligence/DecisionEngine.js';

// Assert helper
function assertEquals(actual, expected, field) {
    if (actual !== expected) {
        return { 
            success: false, 
            error: `Expected ${field}='${expected}', got '${actual}'` 
        };
    }
    return { success: true };
}

// Run all tests async
async function runTests() {
    console.log('🧪 TESTES DO DECISION ENGINE\n');
    
    let passed = 0;
    let total = 0;

    // Test 1: Fluxo completo
    total++;
    try {
        const result = await decisionEngine({
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
        const check = assertEquals(result.handler, 'bookingHandler', 'handler');
        if (check.success) {
            console.log('✅ Deve ir para booking quando tem todos os dados');
            passed++;
        } else {
            console.log(`❌ Deve ir para booking: ${check.error}`);
        }
    } catch (err) {
        console.log(`❌ Deve ir para booking: ${err.message}`);
    }

    // Test 2: Precisa de terapia
    total++;
    try {
        const result = await decisionEngine({
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
        const check = assertEquals(result.action, 'ask_therapy', 'action');
        if (check.success) {
            console.log('✅ Deve pedir terapia quando não tem');
            passed++;
        } else {
            console.log(`❌ Deve pedir terapia: ${check.error}`);
        }
    } catch (err) {
        console.log(`❌ Deve pedir terapia: ${err.message}`);
    }

    // Test 3: Drive para agendamento
    total++;
    try {
        const result = await decisionEngine({
            analysis: {
                intent: 'general_info',
                extractedInfo: { queixa: 'fala pouco' }
            },
            missing: {
                needsTherapy: false,
                needsComplaint: false,
                needsAge: true,
                needsPeriod: true
            },
            urgency: 1,
            bookingContext: {},
            clinicalRules: {},
            context: {}
        });
        const check = assertEquals(result.action, 'ask_age', 'action');
        if (check.success) {
            console.log('✅ Deve detectar interesse implícito');
            passed++;
        } else {
            console.log(`❌ Deve detectar interesse: ${check.error}`);
        }
    } catch (err) {
        console.log(`❌ Deve detectar interesse: ${err.message}`);
    }

    // Test 4: Interrupção (pergunta preço durante coleta de dados)
    total++;
    try {
        const result = await decisionEngine({
            analysis: { 
                intent: 'price',
                missing: { needsTherapy: false } // já passou da terapia
            },
            missing: {
                needsTherapy: false,  // já tem terapia
                needsComplaint: false, // já tem queixa
                needsAge: true,        // está esperando idade
                currentAwaiting: 'age'
            },
            urgency: 1,
            bookingContext: {
                slots: null,
                chosenSlot: null
            },
            clinicalRules: {},
            context: { messageCount: 5 } // não é primeira mensagem
        });
        const check = assertEquals(result.preserveBookingState, true, 'preserveBookingState');
        if (check.success) {
            console.log('✅ Deve preservar estado em interrupção');
            passed++;
        } else {
            console.log(`❌ Deve preservar estado: ${check.error} (handler: ${result.handler}, action: ${result.action})`);
        }
    } catch (err) {
        console.log(`❌ Deve preservar estado: ${err.message}`);
    }

    // Test 5: Coleta de queixa
    total++;
    try {
        const result = await decisionEngine({
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
        const check = assertEquals(result.handler, 'complaintCollectionHandler', 'handler');
        if (check.success) {
            console.log('✅ Deve coletar queixa');
            passed++;
        } else {
            console.log(`❌ Deve coletar queixa: ${check.error}`);
        }
    } catch (err) {
        console.log(`❌ Deve coletar queixa: ${err.message}`);
    }

    // Test 6: Preço
    total++;
    try {
        const result = await decisionEngine({
            analysis: { intent: 'price' },
            missing: { needsTherapy: true },
            urgency: 1,
            bookingContext: {},
            clinicalRules: {}
        });
        const check = assertEquals(result.handler, 'productHandler', 'handler');
        if (check.success) {
            console.log('✅ Deve ir para productHandler');
            passed++;
        } else {
            console.log(`❌ Deve ir para productHandler: ${check.error}`);
        }
    } catch (err) {
        console.log(`❌ Deve ir para productHandler: ${err.message}`);
    }

    // Summary
    console.log(`\n${'='.repeat(40)}`);
    console.log(`📊 RESULTADO: ${passed}/${total} testes passaram`);
    console.log('='.repeat(40));
    
    return passed === total;
}

// Run
runTests().then(success => {
    process.exit(success ? 0 : 1);
});
