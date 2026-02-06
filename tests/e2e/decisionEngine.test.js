/**
 * 🧪 TESTES E2E - DecisionEngine
 * 
 * Testes end-to-end para todos os cenários F1-F7 e Gaps P0
 * Execute: node backend/tests/e2e/decisionEngine.test.js
 */

import { decide } from '../../services/intelligence/DecisionEngine.js';
import { resetMetrics, getMetricsReport } from '../../services/analytics/decisionTracking.js';

// Cores para output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m'
};

let testsPassed = 0;
let testsFailed = 0;

async function runTest(name, testFn) {
    try {
        await testFn();
        console.log(`${colors.green}✅ PASS${colors.reset}: ${name}`);
        testsPassed++;
    } catch (error) {
        console.log(`${colors.red}❌ FAIL${colors.reset}: ${name}`);
        console.log(`   ${colors.red}${error.message}${colors.reset}`);
        testsFailed++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertContains(text, substring, message) {
    if (!text || !text.toLowerCase().includes(substring.toLowerCase())) {
        throw new Error(message || `Expected "${text}" to contain "${substring}"`);
    }
}

// ============================================================================
// 🧪 CENÁRIOS DE TESTE
// ============================================================================

const scenarios = {
    // F2: Value-before-price (usando idade >6 para não acionar F7)
    f2_valueBeforePrice: async () => {
        const result = await decide({
            message: { text: 'Quanto custa?' },
            memory: { 
                therapyArea: 'fonoaudiologia',
                patientAge: 8,  // >6 anos para não acionar F7
                complaint: 'Atraso na fala'
            },
            flags: { asksPrice: true },
            lead: { _id: 'test_f2_1' }
        });
        
        assert(result.action === 'smart_response', 'Deve ser smart_response');
        assertContains(result.text, 'avaliação fonoaudiológica', 'Deve explicar o valor primeiro');
        assertContains(result.text, 'R$ 200', 'Deve mencionar o preço');
    },

    // F3: Insurance bridge (com neuropsicologia para ter laudo)
    f3_insuranceBridge: async () => {
        const result = await decide({
            message: { text: 'Vocês aceitam convênio?' },
            memory: { 
                therapyArea: 'neuropsicologia'  // Para ter hasLaudo = true
            },
            flags: { asksPlans: true },
            lead: { _id: 'test_f3_1' }
        });
        
        assert(result.action === 'smart_response', 'Deve ser smart_response');
        assertContains(result.text, 'particulares', 'Deve explicar que é particular');
        assertContains(result.text, 'laudo', 'Deve mencionar laudo para reembolso');
        assertContains(result.text, 'não entra no rol', 'Deve explicar por que não aceita');
    },

    // F4: Seamless handover
    f4_seamlessHandover: async () => {
        const result = await decide({
            message: { text: 'Quero agendar!' },
            memory: {
                therapyArea: 'psicologia',
                patientAge: 8,
                complaint: 'Dificuldade escolar',
                preferredPeriod: 'manhã'
            },
            flags: {},
            lead: { _id: 'test_f4_1' }
        });
        
        assert(result.action === 'show_slots', 'Deve ir direto para show_slots');
        assertContains(result.text, 'vagas', 'Deve mencionar vagas');
    },

    // F5: Smart repetition - evitar repetir
    f5_smartRepetition: async () => {
        const result = await decide({
            message: { text: 'Ela tem 6 anos' },
            memory: {
                askedQuestions: [{ field: 'age', timestamp: new Date() }],
                lastInteraction: new Date()
            },
            flags: {},
            lead: { _id: 'test_f5_1' }
        });
        
        // Não deve perguntar idade de novo se já mencionou
        assert(!result.text?.includes('quantos anos'), 'Não deve repetir pergunta de idade');
    },

    // F6: Emotional support (idade >6 para não acionar F7)
    f6_emotionalSupport: async () => {
        const result = await decide({
            message: { text: 'Estou muito preocupada' },
            memory: {
                patientAge: 8,  // >6 anos para não acionar F7
                userExpressedPain: true
            },
            flags: { userExpressedPain: true },
            lead: { _id: 'test_f6_1' }
        });
        
        assertContains(result.text, 'preocupação', 'Deve acolher a preocupação');
    },

    // F7: Urgency prioritization (bebê ≤6 anos, primeiro contato)
    f7_urgencyPrioritization: async () => {
        const result = await decide({
            message: { text: 'Oi, preciso de ajuda' },
            memory: {
                patientAge: 2,  // Bebê ≤6 anos
                messageCount: 1,  // Primeiro contato
                urgencyAcknowledged: false  // Ainda não reconheceu urgência
            },
            flags: {},
            lead: { _id: 'test_f7_1' }
        });
        
        assert(result.action === 'developmental_urgency', 'Deve acionar urgency developmental');
        assertContains(result.text, 'fase', 'Deve mencionar fase desenvolvimental');
        assertContains(result.text, 'prioridade', 'Deve oferecer prioridade');
    },

    // Warm Lead Detection
    warmLeadDetection: async () => {
        const result = await decide({
            message: { text: 'Vou pensar e te retorno' },
            memory: {},
            flags: {},
            lead: { _id: 'test_wl_1' }
        });
        
        // Verifica apenas a ação e o texto (o agendamento depende de MongoDB real)
        assert(result.action === 'warm_lead_close', 'Deve detectar warm lead');
        assertContains(result.text, 'pens', 'Deve reconhecer intenção de pensar');
        // Nota: followupScheduled pode ser false em teste sem MongoDB real
    },

    // Teste completo: Fluxo de qualificação
    fullQualificationFlow: async () => {
        let result;
        const leadId = 'test_full_1';
        
        // 1. Primeiro contato - deve pedir queixa
        result = await decide({
            message: { text: 'Oi' },
            memory: {},
            flags: {},
            lead: { _id: leadId }
        });
        assertContains(result.text, 'situação', 'Deve perguntar a queixa');
        
        // 2. Responde queixa - deve pedir terapia
        result = await decide({
            message: { text: 'Meu filho não fala direito' },
            memory: { complaint: 'Atraso na fala' },
            flags: {},
            lead: { _id: leadId }
        });
        assertContains(result.text, 'área', 'Deve perguntar a terapia');
        
        // 3. Responde terapia - deve pedir idade
        result = await decide({
            message: { text: 'Fonoaudiologia' },
            memory: { 
                complaint: 'Atraso na fala',
                therapyArea: 'fonoaudiologia'
            },
            flags: {},
            lead: { _id: leadId }
        });
        assert(result.extractedInfo?.awaitingField === 'age' || result.text?.toLowerCase().includes('anos') || result.text?.toLowerCase().includes('idade'), 'Deve perguntar a idade');
    }
};

// ============================================================================
// 🚀 EXECUÇÃO DOS TESTES
// ============================================================================

async function runAllTests() {
    console.log(`${colors.blue}🧪 DecisionEngine E2E Tests${colors.reset}\n`);
    
    resetMetrics();
    
    // F1-F7 Tests
    console.log(`${colors.yellow}📋 Testando Gaps F1-F7...${colors.reset}`);
    await runTest('F2: Value-before-price', scenarios.f2_valueBeforePrice);
    await runTest('F3: Insurance bridge', scenarios.f3_insuranceBridge);
    await runTest('F4: Seamless handover', scenarios.f4_seamlessHandover);
    await runTest('F5: Smart repetition', scenarios.f5_smartRepetition);
    await runTest('F6: Emotional support', scenarios.f6_emotionalSupport);
    await runTest('F7: Urgency prioritization', scenarios.f7_urgencyPrioritization);
    
    console.log(`\n${colors.yellow}📋 Testando Features Adicionais...${colors.reset}`);
    await runTest('Warm Lead Detection', scenarios.warmLeadDetection);
    await runTest('Full Qualification Flow', scenarios.fullQualificationFlow);
    
    // Relatório
    console.log(`\n${colors.blue}📊 RESULTADO:${colors.reset}`);
    console.log(`   ✅ Passaram: ${testsPassed}`);
    console.log(`   ❌ Falharam: ${testsFailed}`);
    console.log(`   📈 Total: ${testsPassed + testsFailed}`);
    
    const metrics = getMetricsReport();
    console.log(`\n${colors.blue}📊 MÉTRICAS COLETADAS:${colors.reset}`);
    console.log(`   Gaps utilizados:`, metrics.gaps);
    
    if (testsFailed === 0) {
        console.log(`\n${colors.green}🎉 TODOS OS TESTES PASSARAM!${colors.reset}`);
        process.exit(0);
    } else {
        console.log(`\n${colors.red}⚠️  ALGUNS TESTES FALHARAM${colors.reset}`);
        process.exit(1);
    }
}

// Executar se for rodado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests().catch(console.error);
}

export { scenarios, runAllTests };
