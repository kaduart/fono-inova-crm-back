/**
 * 🧪 Teste Rápido - Recuperação de Contexto
 * 
 * Testa o cenário crítico:
 * 1. Lead tem therapyArea='psicologia' salvo
 * 2. Usuário envia só o nome "Gabriel"
 * 3. Amanda DEVE recuperar therapyArea e não perguntar qual área
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import { enrichLeadContext } from '../services/leadContext.js';

// Mock de lead no estado que queremos testar
const createMockLead = (overrides = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    name: 'Mãe do Gabriel',
    contact: { phone: '5561999999999' },
    therapyArea: 'psicologia',
    patientInfo: {
        fullName: null,  // Ainda não tem
        age: null
    },
    qualificationData: {
        extractedInfo: {}
    },
    interactions: [],
    ...overrides
});

// Testa um cenário
async function testScenario(name, lead, userText, expectedBehavior) {
    console.log(`\n🧪 ${name}`);
    console.log('─'.repeat(60));
    console.log('📱 Usuário:', `"${userText}"`);
    console.log('💾 Lead tem:', {
        therapyArea: lead.therapyArea,
        name: lead.patientInfo?.fullName,
        age: lead.patientInfo?.age
    });
    
    const startTime = Date.now();
    
    try {
        const response = await getOptimizedAmandaResponse({
            content: userText,
            userText,
            lead,
            context: {}
        });
        
        const duration = Date.now() - startTime;
        
        console.log('🤖 Amanda:', `"${response?.substring(0, 100)}${response?.length > 100 ? '...' : ''}"`);
        console.log('⏱️  Tempo:', `${duration}ms`);
        
        // Validações
        const checks = [];
        
        if (expectedBehavior.shouldNotAskArea) {
            const askedArea = /qual.*(área|especialidade)|fonoaudiologia|psicologia|terapia/i.test(response);
            checks.push({
                name: 'Não pergunta área',
                pass: !askedArea,
                detail: askedArea ? '❌ Perguntou qual área novamente' : '✅ Não perguntou área'
            });
        }
        
        if (expectedBehavior.shouldMentionArea) {
            const mentionedArea = /psicologia|fonoaudiologia|neuropsicologia/i.test(response);
            checks.push({
                name: 'Menciona área',
                pass: mentionedArea,
                detail: mentionedArea ? '✅ Mencionou a área' : '❌ Não mencionou a área'
            });
        }
        
        if (expectedBehavior.shouldAskName) {
            const askedName = /nome.*completo|qual.*nome/i.test(response);
            checks.push({
                name: 'Pergunta nome',
                pass: askedName,
                detail: askedName ? '✅ Perguntou nome' : '❌ Não perguntou nome'
            });
        }
        
        if (expectedBehavior.shouldAskAge) {
            const askedAge = /idade|anos|meses/i.test(response);
            checks.push({
                name: 'Pergunta idade',
                pass: askedAge,
                detail: askedAge ? '✅ Perguntou idade' : '❌ Não perguntou idade'
            });
        }
        
        console.log('✅ Validações:');
        checks.forEach(c => console.log(`   ${c.detail}`));
        
        const allPassed = checks.every(c => c.pass);
        console.log(allPassed ? '\n🟢 PASSOU' : '\n🔴 FALHOU');
        
        return { pass: allPassed, checks, duration };
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
        return { pass: false, error: error.message };
    }
}

// Cenários de teste
const SCENARIOS = [
    // Cenário 1: O bug crítico
    {
        name: 'BUG CRÍTICO: Tem área, falta nome',
        lead: createMockLead({
            therapyArea: 'psicologia',
            patientInfo: { fullName: null, age: null }
        }),
        text: 'Gabriel',
        expected: {
            shouldNotAskArea: true,    // NÃO deve perguntar qual área
            shouldMentionArea: true,   // DEVE mencionar "psicologia"
            shouldAskName: false,      // Já tem o nome na mensagem
            shouldAskAge: true         // DEVE perguntar idade
        }
    },
    
    // Cenário 2: Tem área e nome, falta idade
    {
        name: 'Tem área e nome, falta idade',
        lead: createMockLead({
            therapyArea: 'fonoaudiologia',
            patientInfo: { fullName: 'Maria Silva', age: null }
        }),
        text: 'Bom dia',
        expected: {
            shouldNotAskArea: true,
            shouldMentionArea: true,
            shouldAskName: false,
            shouldAskAge: true
        }
    },
    
    // Cenário 3: Completo, só confirma
    {
        name: 'Dados completos',
        lead: createMockLead({
            therapyArea: 'neuropsicologia',
            patientInfo: { fullName: 'João Pedro', age: 8 },
            pendingPreferredPeriod: 'tarde'
        }),
        text: 'Ok, pode ser',
        expected: {
            shouldNotAskArea: true,
            shouldMentionArea: true,
            shouldAskName: false,
            shouldAskAge: false
        }
    },
    
    // Cenário 4: Sem dados (novo lead)
    {
        name: 'Lead novo - sem dados',
        lead: createMockLead({
            therapyArea: null,
            patientInfo: { fullName: null, age: null }
        }),
        text: 'Oi, quero agendar',
        expected: {
            shouldNotAskArea: false,   // DEVE perguntar área
            shouldMentionArea: false,
            shouldAskName: false,
            shouldAskAge: false
        }
    },
    
    // Cenário 5: Tem tudo no qualificationData (legado)
    {
        name: 'Dados no qualificationData (legado)',
        lead: createMockLead({
            therapyArea: null,
            patientInfo: { fullName: null, age: null },
            qualificationData: {
                extractedInfo: {
                    especialidade: 'psicologia',
                    nome: 'Ana Clara',
                    idade: 6
                }
            }
        }),
        text: 'Quando tem vaga?',
        expected: {
            shouldNotAskArea: true,
            shouldMentionArea: true,
            shouldAskName: false,
            shouldAskAge: false
        }
    }
];

// Roda todos os testes
async function runAllTests() {
    console.log('🧪 Teste de Recuperação de Contexto - Amanda 2.0');
    console.log('=' .repeat(60));
    
    const results = [];
    
    for (const scenario of SCENARIOS) {
        const result = await testScenario(
            scenario.name,
            scenario.lead,
            scenario.text,
            scenario.expected
        );
        
        results.push({
            name: scenario.name,
            ...result
        });
    }
    
    // Relatório final
    console.log('\n' + '='.repeat(60));
    console.log('📊 RELATÓRIO FINAL');
    console.log('='.repeat(60));
    
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    const avgDuration = results.reduce((a, r) => a + (r.duration || 0), 0) / results.length;
    
    console.log(`\n✅ Passaram: ${passed}/${results.length}`);
    console.log(`❌ Falharam: ${failed}/${results.length}`);
    console.log(`⏱️  Tempo médio: ${avgDuration.toFixed(0)}ms`);
    
    if (failed > 0) {
        console.log('\n🔴 Cenários com falha:');
        results.filter(r => !r.pass).forEach(r => {
            console.log(`   - ${r.name}`);
            if (r.error) console.log(`     Erro: ${r.error}`);
        });
    }
    
    return { passed, failed, total: results.length };
}

// Exporta para uso como módulo
export { testScenario, SCENARIOS, runAllTests };

// Roda se executado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}
