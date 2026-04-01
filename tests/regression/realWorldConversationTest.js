/**
 * 🎯 Real World Conversation Test - Teste com Padrões Reais Minerados
 * 
 * Usa conversas reais extraídas do sistema para validar
 * a qualidade das respostas da Amanda de forma assertiva.
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import Lead from '../models/Leads.js';

// Importa padrões reais
import { REAL_WORLD_PATTERNS } from '../config/real-world-training.js';
import analysisData from '../config/mined-patterns/analysis-complete.json' assert { type: 'json' };

const C = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
};

// ============================================
// 📊 CONVERSAS REAIS EXTRAÍDAS DO SISTEMA
// ============================================
const REAL_CONVERSATIONS = [
    // Conversa 1: Fluxo completo fono (extraído de conversas reais)
    {
        name: "Caso Real #1 - Teste da linguinha",
        lead: { therapyArea: null, patientInfo: {} },
        messages: [
            { 
                text: "Fazem teste da linguinha?", 
                expected: { 
                    therapyArea: 'fonoaudiologia',
                    responseContains: ['fazemos', 'teste', 'linguinha', '200'],
                    empathy: true
                }
            },
            { 
                text: "Quanto custa?", 
                expected: { 
                    responseContains: ['R$', '200', 'avaliação'],
                    clearNextStep: true
                }
            },
            { 
                text: "Ele se chama Miguel", 
                expected: { 
                    patientName: 'Miguel',
                    personalization: true,
                    asksAge: true
                }
            },
            { 
                text: "Tem 8 meses", 
                expected: { 
                    patientAge: 0.8,
                    responseContains: ['meses', 'manhã', 'tarde'],
                    periodOptions: true
                }
            }
        ]
    },
    
    // Conversa 2: Dúvida sobre plano → particular (caso real frequente)
    {
        name: "Caso Real #2 - Plano → Particular",
        lead: { therapyArea: null, patientInfo: {} },
        messages: [
            { 
                text: "Vocês atendem plano ou só particular?", 
                expected: { 
                    responseContains: ['particular', 'reembolso', 'nota fiscal'],
                    mentionsInsurance: false,
                    offersPrice: true
                }
            },
            { 
                text: "Qual o valor da avaliação neuropsicológica?", 
                expected: { 
                    responseContains: ['2000', '10 sessões', 'laudo'],
                    explainsProcess: true
                }
            }
        ]
    },
    
    // Conversa 3: Mãe ansiosa com dificuldade escolar
    {
        name: "Caso Real #3 - Dificuldade escolar",
        lead: { therapyArea: null, patientInfo: {} },
        messages: [
            { 
                text: "Minha filha não está aprendendo na escola", 
                expected: { 
                    therapyArea: 'neuropsicologia',
                    empathy: true,
                    responseContains: ['entendo', 'preocupação', 'escola', 'aprendizagem'],
                    offersAssessment: true
                }
            },
            { 
                text: "Ela tem 7 anos e está na primeira série", 
                expected: { 
                    patientAge: 7,
                    contextAware: true,
                    responseContains: ['primeira série', 'ajudar'],
                    asksPreferredTime: true
                }
            }
        ]
    },
    
    // Conversa 4: Múltiplas terapias
    {
        name: "Caso Real #4 - Múltiplas terapias",
        lead: { therapyArea: null, patientInfo: {} },
        messages: [
            { 
                text: "Preciso de fono e psico para meu filho", 
                expected: { 
                    flagsMultidisciplinary: true,
                    responseContains: ['multiprofissional', 'equipe', 'juntas'],
                    suggestsStartingWithOne: true
                }
            },
            { 
                text: "Qual começamos primeiro?", 
                expected: { 
                    providesGuidance: true,
                    responseContains: ['fonoaudiologia', 'psicologia', 'começar'],
                    asksChildInfo: true
                }
            }
        ]
    },
    
    // Conversa 5: Objetação de preço
    {
        name: "Caso Real #5 - Objeção preço",
        lead: { therapyArea: 'neuropsicologia', patientInfo: { fullName: 'Ana', age: 6 } },
        messages: [
            { 
                text: "2000 reais é muito caro, não vou conseguir", 
                expected: { 
                    empathy: true,
                    responseContains: ['entendo', 'investimento', 'parcelamento'],
                    offersInstallments: true,
                    notAggressive: true
                }
            }
        ]
    },
    
    // Conversa 6: Sábado/fim de semana (caso edge)
    {
        name: "Caso Real #6 - Fim de semana",
        lead: { therapyArea: null, patientInfo: {} },
        messages: [
            { 
                text: "Tem vaga para sábado?", 
                expected: { 
                    responseContains: ['segunda', 'sexta', 'manhã', 'tarde'],
                    notAvailableWeekend: true,
                    offersAlternative: true
                }
            }
        ]
    },
    
    // Conversa 7: Criança doente - remarcar
    {
        name: "Caso Real #7 - Remarcação doença",
        lead: { therapyArea: 'fonoaudiologia', patientInfo: { fullName: 'Pedro', age: 4 } },
        messages: [
            { 
                text: "Meu filho gripou, preciso remarcar", 
                expected: { 
                    empathy: true,
                    responseContains: ['melhoras', 'ficar em casa', 'remarcar'],
                    noPenalty: true,
                    offersNextAvailable: true
                }
            }
        ]
    },
    
    // Conversa 8: Urgência emocional
    {
        name: "Caso Real #8 - Urgência emocional",
        lead: { therapyArea: null, patientInfo: {} },
        messages: [
            { 
                text: "Preciso urgente de ajuda, meu filho está agressivo", 
                expected: { 
                    empathy: true,
                    urgency: true,
                    responseContains: ['entendo', 'preocupação', 'agenda', 'prioridade'],
                    offersSoonestSlot: true,
                    notPanicky: true
                }
            }
        ]
    }
];

// ============================================
// 🧪 AVALIADOR DE RESPOSTAS
// ============================================
class ResponseEvaluator {
    evaluate(response, expected, context = {}) {
        const checks = [];
        let score = 0;
        
        // Verifica se resposta existe
        if (!response) {
            return { score: 0, passed: false, checks: [{ name: 'Resposta existe', pass: false }] };
        }
        
        // Verifica conteúdo esperado
        if (expected.responseContains) {
            for (const term of expected.responseContains) {
                const found = response.toLowerCase().includes(term.toLowerCase());
                checks.push({ name: `Contém "${term}"`, pass: found });
                if (found) score += 2;
            }
        }
        
        // Verifica empatia
        if (expected.empathy) {
            const hasEmpathy = /\b(entendo|compreendo|sei|imagino|deve ser|difícil|preocupação)\b/i.test(response);
            checks.push({ name: 'Mostra empatia', pass: hasEmpathy });
            if (hasEmpathy) score += 3;
        }
        
        // Verifica próximo passo claro
        if (expected.clearNextStep) {
            const hasNextStep = /\b(qual|nome|idade|manhã|tarde|período|quando|agendar)\b/i.test(response);
            checks.push({ name: 'Próximo passo claro', pass: hasNextStep });
            if (hasNextStep) score += 2;
        }
        
        // Verifica personalização
        if (expected.personalization && context.patientName) {
            const firstName = context.patientName.split(' ')[0];
            const isPersonalized = response.includes(firstName);
            checks.push({ name: 'Personaliza com nome', pass: isPersonalized });
            if (isPersonalized) score += 2;
        }
        
        // Verifica se NÃO é agressivo/comercial demais
        if (expected.notAggressive) {
            const isAggressive = /\b(corre|agora|rápido|só hoje|última chance)\b/i.test(response);
            checks.push({ name: 'Não é agressivo', pass: !isAggressive });
            if (!isAggressive) score += 2;
        }
        
        // Verifica se oferece alternativa
        if (expected.offersAlternative) {
            const hasAlternative = /\b(segunda|terça|quarta|quinta|sexta|manhã|tarde|outro|próxima)\b/i.test(response);
            checks.push({ name: 'Oferece alternativa', pass: hasAlternative });
            if (hasAlternative) score += 2;
        }
        
        const maxScore = this.calculateMaxScore(expected);
        const normalizedScore = Math.min(10, (score / maxScore) * 10);
        
        return {
            score: normalizedScore,
            passed: normalizedScore >= 6,
            checks,
            response: response.substring(0, 100)
        };
    }
    
    calculateMaxScore(expected) {
        let max = 0;
        if (expected.responseContains) max += expected.responseContains.length * 2;
        if (expected.empathy) max += 3;
        if (expected.clearNextStep) max += 2;
        if (expected.personalization) max += 2;
        if (expected.notAggressive) max += 2;
        if (expected.offersAlternative) max += 2;
        return max || 5;
    }
}

// ============================================
// 🎮 SIMULADOR
// ============================================
class RealWorldSimulator {
    constructor() {
        this.evaluator = new ResponseEvaluator();
        this.results = [];
    }
    
    async runConversation(conversation, index) {
        console.log(`\n${C.cyan}${'='.repeat(70)}${C.reset}`);
        console.log(`${C.cyan}🎮 ${conversation.name}${C.reset}`);
        console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);
        
        let lead = { 
            _id: new mongoose.Types.ObjectId(),
            name: 'Responsável',
            contact: { phone: '5561999999999' },
            ...conversation.lead,
            patientInfo: { ...conversation.lead.patientInfo }
        };
        
        const turnResults = [];
        
        for (const turn of conversation.messages) {
            console.log(`\n${C.blue}📨 Usuário: "${turn.text}"${C.reset}`);
            
            try {
                const response = await getOptimizedAmandaResponse({
                    content: turn.text,
                    userText: turn.text,
                    lead,
                    context: {}
                });
                
                console.log(`${C.green}🤖 Amanda: "${response?.substring(0, 80)}..."${C.reset}`);
                
                const evaluation = this.evaluator.evaluate(response, turn.expected, lead);
                
                const color = evaluation.score >= 8 ? C.green : evaluation.score >= 6 ? C.yellow : C.red;
                console.log(`${color}   ⭐ Score: ${evaluation.score.toFixed(1)}/10${C.reset}`);
                
                // Mostra checks que falharam
                const failed = evaluation.checks.filter(c => !c.pass);
                if (failed.length > 0) {
                    console.log(`   ❌ Falhou: ${failed.map(f => f.name).join(', ')}`);
                }
                
                turnResults.push({
                    input: turn.text,
                    evaluation,
                    response: response?.substring(0, 100)
                });
                
            } catch (error) {
                console.error(`${C.red}❌ Erro: ${error.message}${C.reset}`);
                turnResults.push({ input: turn.text, error: error.message });
            }
        }
        
        const avgScore = turnResults.filter(t => t.evaluation).reduce((a, t) => a + t.evaluation.score, 0) / turnResults.length;
        
        this.results.push({
            conversation: conversation.name,
            avgScore,
            turns: turnResults
        });
        
        return { avgScore, turns: turnResults };
    }
    
    generateReport() {
        console.log(`\n${C.cyan}${'='.repeat(70)}${C.reset}`);
        console.log(`${C.cyan}📊 RELATÓRIO FINAL - TESTES COM CONVERSAS REAIS${C.reset}`);
        console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);
        
        const avgScore = this.results.reduce((a, r) => a + r.avgScore, 0) / this.results.length;
        const passed = this.results.filter(r => r.avgScore >= 6).length;
        
        console.log(`\n📈 Média Geral: ${avgScore.toFixed(1)}/10`);
        console.log(`✅ Conversas aprovadas: ${passed}/${this.results.length}`);
        
        // Ranking
        console.log(`\n🏆 Ranking de Conversas:`);
        this.results
            .sort((a, b) => b.avgScore - a.avgScore)
            .forEach((r, i) => {
                const color = r.avgScore >= 8 ? C.green : r.avgScore >= 6 ? C.yellow : C.red;
                console.log(`   ${i+1}. ${color}${r.conversation}: ${r.avgScore.toFixed(1)}/10${C.reset}`);
            });
        
        return { avgScore, passed, total: this.results.length, results: this.results };
    }
}

// ============================================
// 🚀 EXECUÇÃO
// ============================================
async function main() {
    console.log(`${C.cyan}${C.bold}`);
    console.log('🎯 REAL WORLD CONVERSATION TEST');
    console.log('Testando Amanda com conversas REAIS do sistema');
    console.log(`${C.reset}\n`);
    
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
        console.log(`${C.green}✅ Conectado ao MongoDB${C.reset}\n`);
        
        const simulator = new RealWorldSimulator();
        
        for (let i = 0; i < REAL_CONVERSATIONS.length; i++) {
            await simulator.runConversation(REAL_CONVERSATIONS[i], i);
        }
        
        const report = simulator.generateReport();
        
        // Salva relatório
        const fs = await import('fs/promises');
        const reportPath = `./test-reports/real-world-test-${Date.now()}.json`;
        await fs.mkdir('./test-reports', { recursive: true });
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
        console.log(`\n💾 Relatório salvo: ${reportPath}`);
        
    } catch (error) {
        console.error(`${C.red}❌ Erro: ${error.message}${C.reset}`);
    } finally {
        await mongoose.disconnect();
    }
}

// Exporta
export { RealWorldSimulator, REAL_CONVERSATIONS, ResponseEvaluator };

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
