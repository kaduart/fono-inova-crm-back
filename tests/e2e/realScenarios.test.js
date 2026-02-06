/**
 * 🧪 TESTES COM CENÁRIOS REAIS - Baseado em 43k conversas
 * 
 * Cada teste representa um padrão real identificado nas conversas
 */

import { decide } from '../../services/intelligence/DecisionEngine.js';
import { resetMetrics, getMetricsReport } from '../../services/analytics/decisionTracking.js';

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    gray: '\x1b[90m'
};

let testsPassed = 0;
let testsFailed = 0;

async function runTest(name, testFn) {
    try {
        await testFn();
        console.log(`${colors.green}✅${colors.reset} ${name}`);
        testsPassed++;
    } catch (error) {
        console.log(`${colors.red}❌${colors.reset} ${name}`);
        console.log(`   ${colors.gray}${error.message}${colors.reset}`);
        testsFailed++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertContains(text, substring, message) {
    if (!text || !text.toLowerCase().includes(substring.toLowerCase())) {
        throw new Error(message || `Esperado "${substring}" em "${text?.substring(0, 50)}"`);
    }
}

// ============================================================================
// CENÁRIOS REAIS DAS 43K CONVERSAS
// ============================================================================

const realScenarios = {
    // CENÁRIO 1: Lead pergunta preço no primeiro contato (42x nas conversas)
    'C01: Preço no primeiro contato': async () => {
        const result = await decide({
            message: { text: 'Quanto custa a avaliação?' },
            memory: {}, // Sem contexto
            flags: { asksPrice: true },
            lead: { _id: 'real_01' }
        });
        
        // Deve explicar valor ANTES de dar preço
        assert(result.action === 'smart_response', 'Deve ser smart_response');
        assert(!result.text?.match(/^\d/), 'Não deve começar com número');
        assertContains(result.text, 'avaliação');
    },

    // CENÁRIO 2: Lead diz "vou pensar" (3x explícito nas conversas)
    'C02: Lead morno - vai pensar': async () => {
        const result = await decide({
            message: { text: 'Vou pensar e te retorno depois' },
            memory: { therapyArea: 'fonoaudiologia' },
            flags: {},
            lead: { _id: 'real_02' }
        });
        
        assert(result.action === 'warm_lead_close', 'Deve detectar warm lead');
        assertContains(result.text, 'pens'); // "pensar" ou "pensa"
        assert(!result.text?.includes('Disponha'), 'Nunca dizer Disponha');
    },

    // CENÁRIO 3: Pergunta sobre Unimed/Plano (42x nas conversas)
    'C03: Objeção convênio Unimed': async () => {
        const result = await decide({
            message: { text: 'Vocês atendem Unimed?' },
            memory: {},
            flags: { asksPlans: true },
            lead: { _id: 'real_03' }
        });
        
        assertContains(result.text, 'particular');
        assertContains(result.text, 'laudo'); // Bridge para reembolso
        assertContains(result.text, 'reembolso');
    },

    // CENÁRIO 4: Mãe de bebê com TEA (urgência desenvolvimental)
    'C04: Bebê 2 anos com TEA - urgência': async () => {
        const result = await decide({
            message: { text: 'Oi, meu filho tem 2 anos e suspeita de autismo' },
            memory: {
                patientAge: 2,
                complaint: 'Suspeita de TEA',
                messageCount: 1
            },
            flags: {},
            lead: { _id: 'real_04' }
        });
        
        // Deve priorizar pela idade
        assert(result.action === 'developmental_urgency' || result.text?.includes('fase'), 
            'Deve mencionar fase desenvolvimental');
    },

    // CENÁRIO 5: Lead já preencheu ficha (42x fichas preenchidas)
    'C05: Lead com ficha preenchida - confirmação': async () => {
        const result = await decide({
            message: { text: 'Preenchi a ficha, e agora?' },
            memory: {
                therapyArea: 'psicologia',
                patientAge: 8,
                patientName: 'Pedro',
                complaint: 'Dificuldade escolar'
            },
            flags: { wantsSchedule: true },
            lead: { _id: 'real_05' }
        });
        
        // Deve personalizar com nome da criança
        assertContains(result.text, 'Pedro');
        assertContains(result.text, 'cuidar');
    },

    // CENÁRIO 6: Lead diz "logo eu marco" (padrão morno)
    'C06: Logo eu marco - encerramento com hook': async () => {
        const result = await decide({
            message: { text: 'Logo eu marco, obrigada' },
            memory: { therapyArea: 'fonoaudiologia' },
            flags: {},
            lead: { _id: 'real_06' }
        });
        
        assert(result.action === 'warm_lead_close', 'Deve detectar como warm lead');
        assert(!result.text?.includes('Disponha'), 'Nunca dizer Disponha');
        assertContains(result.text, 'mensagem'); // "vou te mandar mensagem"
    },

    // CENÁRIO 7: Lead cancela agendamento (reagendamento)
    'C07: Cancelamento - reagendamento com empatia': async () => {
        const result = await decide({
            message: { text: 'Preciso cancelar, surgiu um imprevisto' },
            memory: {
                hasAppointment: true,
                therapyArea: 'terapia_ocupacional'
            },
            flags: { isCancellation: true },
            lead: { _id: 'real_07' }
        });
        
        assertContains(result.text, 'sem problema');
        assertContains(result.text, 'rotina'); // Empatia com rotina corrida
    },

    // CENÁRIO 8: Duas crianças (mãe de gêmeos)
    'C08: Mãe de dois filhos - desconto multi-criança': async () => {
        const result = await decide({
            message: { text: 'Tenho dois filhos, João de 5 e Maria de 7' },
            memory: {},
            flags: { hasMultipleChildren: true },
            lead: { _id: 'real_08' }
        });
        
        // Deve detectar múltiplas crianças
        assert(result.text?.toLowerCase().includes('dois') || 
               result.text?.toLowerCase().includes('duas'), 
            'Deve reconhecer múltiplas crianças');
    },

    // CENÁRIO 9: Lead frustrado com demora ("????")
    'C09: Lead frustrado - acolhimento prioritário': async () => {
        const result = await decide({
            message: { text: '????' },
            memory: { messageCount: 5 },
            flags: { expressedFrustration: true },
            lead: { _id: 'real_09' }
        });
        
        // Deve acolher a frustração
        assertContains(result.text, 'desculpa') || assertContains(result.text, 'demora');
    },

    // CENÁRIO 10: Lead pergunta horário específico (7h)
    'C10: Horário 7h - contextualizar benefício': async () => {
        const result = await decide({
            message: { text: 'Tem vaga às 7h?' },
            memory: {
                therapyArea: 'fonoaudiologia',
                patientAge: 4,
                emotionalContext: { specificTimeRequest: 7 }
            },
            flags: { asksSchedule: true },
            lead: { _id: 'real_10' }
        });
        
        // Deve explicar por que 7h é bom e oferecer horário personalizado
        assertContains(result.text, 'rotina') || assertContains(result.text, 'trabalho') || 
        assertContains(result.text, 'personalizado') || assertContains(result.text, 'equipe');
    },

    // CENÁRIO 11: Lead diz "vou consultar meu marido"
    'C11: Consultar família - follow-up agendado': async () => {
        const result = await decide({
            message: { text: 'Vou falar com meu marido e volto' },
            memory: {},
            flags: {},
            lead: { _id: 'real_11' }
        });
        
        assert(result.action === 'warm_lead_close', 'Deve detectar warm lead');
        assertContains(result.text, 'juntos') || assertContains(result.text, 'família');
    },

    // CENÁRIO 12: Lead já foi avaliado mas não continuou
    'C12: Pós-avaliação sem continuidade': async () => {
        const result = await decide({
            message: { text: 'Fiz a avaliação semana passada' },
            memory: {
                hadEvaluation: true,
                evaluationDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                therapyArea: 'psicologia',
                patientName: 'Lucas'
            },
            flags: {},
            lead: { _id: 'real_12' }
        });
        
        assertContains(result.text, 'continuidade');
        assertContains(result.text, 'Lucas'); // Nome da criança
    }
};

// ============================================================================
// EXECUÇÃO
// ============================================================================

async function runAllTests() {
    console.log(`${colors.blue}🧪 Cenários Reais - Baseado em 43k conversas${colors.reset}\n`);
    
    resetMetrics();
    
    console.log(`${colors.yellow}📋 Testando padrões identificados...${colors.reset}`);
    for (const [name, testFn] of Object.entries(realScenarios)) {
        await runTest(name, testFn);
    }
    
    console.log(`\n${colors.blue}📊 RESULTADO:${colors.reset}`);
    console.log(`   ${colors.green}✅${colors.reset} Passaram: ${testsPassed}`);
    console.log(`   ${colors.red}❌${colors.reset} Falharam: ${testsFailed}`);
    console.log(`   📈 Total: ${testsPassed + testsFailed}`);
    
    if (testsFailed === 0) {
        console.log(`\n${colors.green}🎉 TODOS OS CENÁRIOS REAIS PASSARAM!${colors.reset}`);
        process.exit(0);
    } else {
        console.log(`\n${colors.yellow}⚠️  Alguns cenários precisam de ajustes${colors.reset}`);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests().catch(console.error);
}

export { realScenarios, runAllTests };
