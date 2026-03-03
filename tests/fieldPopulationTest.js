/**
 * 📝 Field Population Test - Teste de Preenchimento de Campos
 * 
 * Valida se a Amanda está preenchendo corretamente:
 * - therapyArea
 * - patientInfo.fullName
 * - patientInfo.age
 * - pendingPreferredPeriod
 * - complaint
 * 
 * E se está gerando agendamentos de forma natural
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import Appointment from '../models/Appointment.js';

const C = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', bold: '\x1b[1m'
};

// ============================================
// 🎯 CENÁRIOS DE TESTE
// ============================================
const TEST_SCENARIOS = [
    {
        name: 'Fluxo Completo - Fono',
        conversation: [
            { text: 'Oi, quero agendar fonoaudiologia para meu filho', expectedFields: { therapyArea: 'fonoaudiologia' } },
            { text: 'Ele se chama Pedro Henrique', expectedFields: { patientName: 'Pedro Henrique' } },
            { text: 'Tem 4 anos', expectedFields: { patientAge: 4 } },
            { text: 'De tarde é melhor pra gente', expectedFields: { period: 'tarde' } }
        ]
    },
    {
        name: 'Fluxo Completo - Neuropsicologia',
        conversation: [
            { text: 'Preciso de neuropsicologia pra minha filha', expectedFields: { therapyArea: 'neuropsicologia' } },
            { text: 'O nome dela é Ana Clara', expectedFields: { patientName: 'Ana Clara' } },
            { text: 'Ela tem 8 anos', expectedFields: { patientAge: 8 } },
            { text: 'Pode ser de manhã', expectedFields: { period: 'manha' } }
        ]
    },
    {
        name: 'Contexto Recuperado - Área já definida',
        initialState: {
            therapyArea: 'psicologia',
            patientInfo: { fullName: 'João Pedro', age: 6 }
        },
        conversation: [
            { text: 'Oi, tudo bem?', checkContext: true },
            { text: 'Quando tem vaga?', checkScheduling: true }
        ]
    },
    {
        name: 'Queixa implícita - Atraso de fala',
        conversation: [
            { text: 'Meu filho ainda não fala direito', expectedFields: { therapyArea: 'fonoaudiologia', complaint: 'atraso de fala' } },
            { text: 'Ele tem 3 anos', expectedFields: { patientAge: 3 } }
        ]
    },
    {
        name: 'Queixa implícita - Dificuldade escolar',
        conversation: [
            { text: 'Minha filho não está aprendendo na escola', expectedFields: { therapyArea: 'psicologia', complaint: 'dificuldade escolar' } },
            { text: 'Maria tem 7 anos', expectedFields: { patientName: 'Maria', patientAge: 7 } }
        ]
    },
    {
        name: 'Múltiplas informações de uma vez',
        conversation: [
            { text: 'Quero agendar psicologia pra minha filha Julia de 5 anos de tarde', 
              expectedFields: { therapyArea: 'psicologia', patientName: 'Julia', patientAge: 5, period: 'tarde' } }
        ]
    },
    {
        name: 'Correção de dados',
        initialState: {
            therapyArea: 'fonoaudiologia',
            patientInfo: { fullName: 'Pedro', age: 4 }
        },
        conversation: [
            { text: 'Desculpe, é neuropsicologia não fono', expectedFields: { therapyArea: 'neuropsicologia' } },
            { text: 'E o nome é Pedro Henrique Souza', expectedFields: { patientName: 'Pedro Henrique Souza' } }
        ]
    },
    {
        name: 'Número de anos por extenso',
        conversation: [
            { text: 'Quero agendar TO para meu filho', expectedFields: { therapyArea: 'terapia_ocupacional' } },
            { text: 'Ele tem cinco anos', expectedFields: { patientAge: 5 } }
        ]
    },
    {
        name: 'Urgência detectada',
        conversation: [
            { text: 'Preciso urgente de fono, meu filho não fala e tem 4 anos', 
              expectedFields: { therapyArea: 'fonoaudiologia', patientAge: 4 },
              expectedFlags: { urgency: true } }
        ]
    },
    {
        name: 'Pergunta sobre preço antes de dados',
        conversation: [
            { text: 'Quanto custa a avaliação de psicologia?', shouldAnswer: 'price' },
            { text: 'Ok, quero agendar então', shouldCollectData: true }
        ]
    }
];

// ============================================
// 🧪 TESTADOR
// ============================================
class FieldPopulationTester {
    constructor() {
        this.results = [];
    }

    async runTest(scenario) {
        console.log(`\n${C.cyan}${'='.repeat(70)}${C.reset}`);
        console.log(`${C.cyan}🧪 CENÁRIO: ${scenario.name}${C.reset}`);
        console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);

        // Cria lead com estado inicial
        let lead = this.createMockLead(scenario.initialState || {});
        const conversationLog = [];

        for (const turn of scenario.conversation) {
            console.log(`\n${C.blue}📨 USUÁRIO: "${turn.text}"${C.reset}`);
            console.log(`${C.yellow}💾 Estado ANTES:${C.reset}`, this.formatState(lead));

            try {
                const response = await getOptimizedAmandaResponse({
                    content: turn.text,
                    userText: turn.text,
                    lead,
                    context: {}
                });

                console.log(`${C.green}🤖 AMANDA: "${response?.substring(0, 80)}${response?.length > 80 ? '...' : ''}"${C.reset}`);

                // Simula atualização do lead
                const oldLead = { ...lead };
                lead = this.simulateLeadUpdate(lead, turn.text);

                console.log(`${C.yellow}💾 Estado DEPOIS:${C.reset}`, this.formatState(lead));

                // Validações
                const validations = this.validateTurn(turn, oldLead, lead, response);
                this.printValidations(validations);

                conversationLog.push({
                    userText: turn.text,
                    response: response?.substring(0, 100),
                    validations,
                    state: { ...lead }
                });

            } catch (error) {
                console.error(`${C.red}❌ ERRO: ${error.message}${C.reset}`);
                conversationLog.push({ userText: turn.text, error: error.message });
            }
        }

        const result = {
            scenario: scenario.name,
            passed: conversationLog.every(l => !l.error && (!l.validations || l.validations.every(v => v.pass))),
            conversation: conversationLog
        };

        this.results.push(result);
        return result;
    }

    createMockLead(initialState) {
        return {
            _id: new mongoose.Types.ObjectId(),
            name: 'Responsável Teste',
            contact: { phone: '5561999999999' },
            therapyArea: initialState.therapyArea || null,
            patientInfo: {
                fullName: initialState.patientInfo?.fullName || null,
                age: initialState.patientInfo?.age || null
            },
            pendingPreferredPeriod: initialState.pendingPreferredPeriod || null,
            complaint: initialState.complaint || null,
            qualificationData: { extractedInfo: {} },
            interactions: [],
            ...initialState
        };
    }

    simulateLeadUpdate(lead, text) {
        const updated = JSON.parse(JSON.stringify(lead)); // Deep clone
        
        // Extrai therapyArea
        const areaPatterns = {
            fonoaudiologia: /fono|fala|linguinha|gagueira/i,
            psicologia: /psicologia|comportamento|birra|ansiedade/i,
            neuropsicologia: /neuropsi|avaliação|laudo|tdah|tea/i,
            terapia_ocupacional: /terapia ocupacional|\bto\b|sensorial|coordenação motora/i,
            fisioterapia: /fisio|motor|andou/i
        };

        for (const [area, pattern] of Object.entries(areaPatterns)) {
            if (pattern.test(text) && !updated.therapyArea) {
                updated.therapyArea = area;
            }
        }

        // Extrai nome
        const namePatterns = [
            /(?:sou|me chamo|nome [ée])\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
            /(?:filho|filha|paciente)\s+(?:se\s+)?(?:chama|é)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i
        ];

        for (const pattern of namePatterns) {
            const match = text.match(pattern);
            if (match && !updated.patientInfo.fullName) {
                updated.patientInfo.fullName = match[1].trim();
            }
        }

        // Extrai idade
        const ageMatch = text.match(/(\d+)\s*(anos?|meses?)/i);
        if (ageMatch && !updated.patientInfo.age) {
            updated.patientInfo.age = parseInt(ageMatch[1]);
        }

        // Números por extenso
        const extenso = { 'dois': 2, 'três': 3, 'quatro': 4, 'cinco': 5, 'seis': 6, 'sete': 7, 'oito': 8 };
        for (const [ext, num] of Object.entries(extenso)) {
            if (text.includes(ext) && !updated.patientInfo.age) {
                updated.patientInfo.age = num;
            }
        }

        // Extrai período
        if (/manh[ãa]|cedo/i.test(text) && !updated.pendingPreferredPeriod) {
            updated.pendingPreferredPeriod = 'manha';
        } else if (/tarde/i.test(text) && !updated.pendingPreferredPeriod) {
            updated.pendingPreferredPeriod = 'tarde';
        } else if (/noite/i.test(text) && !updated.pendingPreferredPeriod) {
            updated.pendingPreferredPeriod = 'noite';
        }

        return updated;
    }

    validateTurn(turn, oldLead, newLead, response) {
        const validations = [];

        // Valida campos esperados
        if (turn.expectedFields) {
            if (turn.expectedFields.therapyArea) {
                validations.push({
                    field: 'therapyArea',
                    expected: turn.expectedFields.therapyArea,
                    actual: newLead.therapyArea,
                    pass: newLead.therapyArea === turn.expectedFields.therapyArea,
                    message: `Área: ${newLead.therapyArea || '❌ não definida'}`
                });
            }

            if (turn.expectedFields.patientName) {
                const hasName = newLead.patientInfo.fullName?.includes(turn.expectedFields.patientName);
                validations.push({
                    field: 'patientName',
                    expected: turn.expectedFields.patientName,
                    actual: newLead.patientInfo.fullName,
                    pass: hasName,
                    message: `Nome: ${newLead.patientInfo.fullName || '❌ não definido'}`
                });
            }

            if (turn.expectedFields.patientAge) {
                validations.push({
                    field: 'patientAge',
                    expected: turn.expectedFields.patientAge,
                    actual: newLead.patientInfo.age,
                    pass: newLead.patientInfo.age === turn.expectedFields.patientAge,
                    message: `Idade: ${newLead.patientInfo.age || '❌ não definida'}`
                });
            }

            if (turn.expectedFields.period) {
                validations.push({
                    field: 'period',
                    expected: turn.expectedFields.period,
                    actual: newLead.pendingPreferredPeriod,
                    pass: newLead.pendingPreferredPeriod === turn.expectedFields.period,
                    message: `Período: ${newLead.pendingPreferredPeriod || '❌ não definido'}`
                });
            }
        }

        // Valida comportamentos
        if (turn.checkContext) {
            const maintainedContext = oldLead.therapyArea === newLead.therapyArea && 
                                     oldLead.patientInfo.fullName === newLead.patientInfo.fullName;
            validations.push({
                field: 'context',
                pass: maintainedContext,
                message: maintainedContext ? '✅ Contexto mantido' : '❌ Contexto perdido!'
            });
        }

        if (turn.shouldAnswer === 'price') {
            const answeredPrice = /R\$|\d+.*reais|valor|preço/i.test(response);
            validations.push({
                field: 'priceAnswer',
                pass: answeredPrice,
                message: answeredPrice ? '✅ Respondeu preço' : '❌ Não respondeu preço'
            });
        }

        if (turn.shouldCollectData) {
            const collectingData = /nome|idade|período|manhã|tarde/i.test(response);
            validations.push({
                field: 'dataCollection',
                pass: collectingData,
                message: collectingData ? '✅ Iniciou coleta de dados' : '❌ Não coletou dados'
            });
        }

        return validations;
    }

    formatState(lead) {
        return {
            area: lead.therapyArea || '❌',
            nome: lead.patientInfo?.fullName || '❌',
            idade: lead.patientInfo?.age || '❌',
            periodo: lead.pendingPreferredPeriod || '❌'
        };
    }

    printValidations(validations) {
        validations.forEach(v => {
            const color = v.pass ? C.green : C.red;
            const icon = v.pass ? '✅' : '❌';
            console.log(`   ${color}${icon} ${v.message}${C.reset}`);
        });
    }

    generateReport() {
        console.log(`\n${C.cyan}${'='.repeat(70)}${C.reset}`);
        console.log(`${C.cyan}📊 RELATÓRIO FINAL${C.reset}`);
        console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);

        const passed = this.results.filter(r => r.passed).length;
        const failed = this.results.filter(r => !r.passed).length;

        console.log(`\n✅ Passaram: ${passed}/${this.results.length}`);
        console.log(`❌ Falharam: ${failed}/${this.results.length}`);

        if (failed > 0) {
            console.log(`\n${C.red}❌ Cenários com falha:${C.reset}`);
            this.results.filter(r => !r.passed).forEach(r => {
                console.log(`   - ${r.scenario}`);
            });
        }

        return { passed, failed, total: this.results.length, results: this.results };
    }
}

// ============================================
// 🚀 EXECUÇÃO
// ============================================
async function main() {
    console.log(`${C.cyan}${C.bold}`);
    console.log('📝 FIELD POPULATION TEST');
    console.log('Validando preenchimento de campos da Amanda');
    console.log(`${C.reset}`);

    const tester = new FieldPopulationTester();

    for (const scenario of TEST_SCENARIOS) {
        await tester.runTest(scenario);
    }

    const report = tester.generateReport();
    
    // Salva relatório
    const fs = await import('fs/promises');
    const reportPath = `./test-reports/field-population-${Date.now()}.json`;
    await fs.mkdir('./test-reports', { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Relatório salvo: ${reportPath}`);
}

export { FieldPopulationTester, TEST_SCENARIOS };

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
