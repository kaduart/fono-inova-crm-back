/**
 * 🧠 Psychological Sales Test - Teste de Venda Psicológica
 * 
 * Avalia se as respostas da Amanda são:
 * ✅ Acolhedoras e empáticas
 * ✅ Não forçadas ou agressivas
 * ✅ Personalizadas
 * ✅ Orientadas a solução, não a pressão
 * ✅ Que criam conexão emocional
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';

const C = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', bold: '\x1b[1m'
};

// ============================================
// 🎨 AVALIADOR DE VENDA PSICOLÓGICA
// ============================================
class PsychologicalSalesEvaluator {
    constructor() {
        // Critérios positivos (o que deve ter)
        this.positiveCriteria = {
            empathy: {
                patterns: [
                    /\b(entendo|compreendo|sei que|deve ser difícil|imagino|acolho)\b/i,
                    /\b(lidar|passar|situação|momento)\b.*\b(difícil|complicado|desafiador)\b/i
                ],
                weight: 3,
                name: 'Empatia'
            },
            validation: {
                patterns: [
                    /\b(é normal|muitos pais|comum|natural|faz parte)\b/i,
                    /\b(você está fazendo bem|está no caminho|está certo)\b/i
                ],
                weight: 2,
                name: 'Validação'
            },
            hope: {
                patterns: [
                    /\b(pode melhorar|vai evoluir|tem solução|vai conseguir|conseguimos ajudar)\b/i,
                    /\b(desenvolver|progredir|avançar|superar)\b/i
                ],
                weight: 2,
                name: 'Esperança'
            },
            invitation: {
                patterns: [
                    /\b(pode ser|se quiser|se preferir|gostaria|que tal|como se sente)\b/i,
                    /\b(posso te ajudar|podemos conversar|podemos agendar)\b/i
                ],
                weight: 2,
                name: 'Convite (não imposição)'
            },
            personalization: {
                patterns: [
                    /\b(seu filho|sua filha|o paciente|a criança|nome)\b/i,
                    /\b(\d+\s*anos|pequeno|pequena|bebê)\b/i
                ],
                weight: 1,
                name: 'Personalização'
            },
            softLanguage: {
                patterns: [
                    /\b(poderíamos|talvez|uma opção|alternativa)\b/i,
                    /\b(sujeito|depende|cada caso|individual)\b/i
                ],
                weight: 1,
                name: 'Linguagem Suave'
            }
        };

        // Critérios negativos (o que NÃO deve ter)
        this.negativeCriteria = {
            pressure: {
                patterns: [
                    /\b(corre|rápido|urgente|agora|só hoje|última chance|vai acabar)\b/i,
                    /\b(esgotando|acabando|só tem essa|última vaga)\b/i
                ],
                weight: -4,
                name: 'Pressão'
            },
            tooSalesy: {
                patterns: [
                    /\b(oportunidade única|melhor preço|promoção|desconto exclusivo)\b/i,
                    /\b(não perca|imperdível|sensacional|incrível)\b/i
                ],
                weight: -3,
                name: 'Excesso de Vendas'
            },
            imposition: {
                patterns: [
                    /\b(tem que|precisa|obrigatório|não tem outra|só assim)\b/i,
                    /\b(você deve|é necessário|tem que ser)\b/i
                ],
                weight: -3,
                name: 'Imposição'
            },
            generic: {
                patterns: [
                    /\b(qualquer coisa|tanto faz|não importa|tudo igual)\b/i,
                    /^[Oo]i\!.*$/  // Só "Oi!" sem contexto
                ],
                weight: -2,
                name: 'Resposta Genérica'
            },
            robotic: {
                patterns: [
                    /\b(conforme solicitado|em resposta|conforme pedido)\b/i,
                    /\b(processamos|registramos|anotamos)\b/i
                ],
                weight: -2,
                name: 'Linguagem Robótica'
            }
        };
    }

    evaluate(response, context = {}) {
        const scores = {
            positive: {},
            negative: {},
            total: 0,
            maxPossible: 0
        };

        // Avalia critérios positivos
        for (const [key, criterion] of Object.entries(this.positiveCriteria)) {
            const found = criterion.patterns.some(p => p.test(response));
            const score = found ? criterion.weight : 0;
            scores.positive[key] = {
                found,
                score,
                name: criterion.name
            };
            scores.total += score;
            scores.maxPossible += criterion.weight;
        }

        // Avalia critérios negativos
        for (const [key, criterion] of Object.entries(this.negativeCriteria)) {
            const found = criterion.patterns.some(p => p.test(response));
            const score = found ? criterion.weight : 0;
            scores.negative[key] = {
                found,
                score,
                name: criterion.name
            };
            scores.total += score;
        }

        // Normaliza para escala 0-10
        const normalizedScore = Math.max(0, Math.min(10, 
            (scores.total / Math.max(1, scores.maxPossible)) * 10 + 5
        ));

        return {
            score: normalizedScore,
            rawScore: scores.total,
            maxPossible: scores.maxPossible,
            details: scores,
            rating: this.getRating(normalizedScore),
            feedback: this.generateFeedback(scores, normalizedScore)
        };
    }

    getRating(score) {
        if (score >= 9) return 'EXCELENTE - Venda Psicológica Perfeita';
        if (score >= 7) return 'BOA - Acolhedora e Efetiva';
        if (score >= 5) return 'REGULAR - Pode Melhorar';
        if (score >= 3) return 'RUIM - Muito Comercial';
        return 'PÉSSIMA - Agressiva ou Robótica';
    }

    generateFeedback(scores, totalScore) {
        const feedback = [];

        // Pontos positivos
        const goodPoints = Object.entries(scores.positive)
            .filter(([k, v]) => v.found)
            .map(([k, v]) => v.name);
        
        if (goodPoints.length > 0) {
            feedback.push(`✅ ${goodPoints.join(', ')}`);
        }

        // Pontos negativos
        const badPoints = Object.entries(scores.negative)
            .filter(([k, v]) => v.found)
            .map(([k, v]) => v.name);
        
        if (badPoints.length > 0) {
            feedback.push(`❌ Evitar: ${badPoints.join(', ')}`);
        }

        // Sugestões baseadas no que falta
        if (!scores.positive.empathy.found) {
            feedback.push('💡 Adicionar empatia: "Entendo como deve ser difícil..."');
        }
        if (!scores.positive.invitation.found) {
            feedback.push('💡 Usar convite: "Se quiser, podemos..."');
        }
        if (!scores.positive.hope.found) {
            feedback.push('💡 Transmitir esperança: "Vamos conseguir ajudar..."');
        }

        return feedback;
    }
}

// ============================================
// 🎯 CENÁRIOS DE VENDA PSICOLÓGICA
// ============================================
const PSYCHOLOGICAL_SCENARIOS = [
    {
        name: 'Primeiro contato - Pai preocupado',
        lead: {
            therapyArea: null,
            patientInfo: {}
        },
        message: 'Oi, meu filho não fala ainda e ele tem 3 anos',
        context: { isFirstContact: true }
    },
    {
        name: 'Mãe ansiosa - Urgência',
        lead: {
            therapyArea: 'fonoaudiologia',
            patientInfo: { fullName: 'Pedro', age: 4 }
        },
        message: 'Preciso muito de ajuda, ele está atrasado na escola',
        context: { urgency: 'high' }
    },
    {
        name: 'Desistência - Preço alto',
        lead: {
            therapyArea: 'neuropsicologia',
            patientInfo: { fullName: 'Ana', age: 8 }
        },
        message: '2000 reais é muito caro, não vou conseguir',
        context: { priceObjection: true }
    },
    {
        name: 'Indecisão - Comparando clínicas',
        lead: {
            therapyArea: 'psicologia',
            patientInfo: { fullName: 'João', age: 6 }
        },
        message: 'Estou vendo outras clínicas também, ainda não decidi',
        context: { comparing: true }
    },
    {
        name: 'Resistência - Não acredita',
        lead: {
            therapyArea: null,
            patientInfo: {}
        },
        message: 'Não sei se terapia funciona, já tentamos de tudo',
        context: { skeptical: true }
    },
    {
        name: 'Agendamento - Momento da decisão',
        lead: {
            therapyArea: 'terapia_ocupacional',
            patientInfo: { fullName: 'Maria', age: 5 }
        },
        message: 'Ok, quero agendar então',
        context: { readyToBook: true }
    },
    {
        name: 'Follow-up - Lead frio',
        lead: {
            therapyArea: 'fonoaudiologia',
            patientInfo: { fullName: 'Lucas', age: 3 }
        },
        message: 'Ainda estou pensando',
        context: { cold: true, daysSinceLastContact: 7 }
    },
    {
        name: 'Reclamação - Experiência ruim anterior',
        lead: {
            therapyArea: null,
            patientInfo: {}
        },
        message: 'Já fui em outro lugar e não resolveu',
        context: { previousBadExperience: true }
    }
];

// ============================================
// 🧪 TESTADOR
// ============================================
class PsychologicalSalesTester {
    constructor() {
        this.evaluator = new PsychologicalSalesEvaluator();
        this.results = [];
    }

    async runTest(scenario) {
        console.log(`\n${C.magenta}${'='.repeat(70)}${C.reset}`);
        console.log(`${C.magenta}🧠 CENÁRIO: ${scenario.name}${C.reset}`);
        console.log(`${C.blue}💬 USUÁRIO: "${scenario.message}"${C.reset}`);
        
        try {
            const response = await getOptimizedAmandaResponse({
                content: scenario.message,
                userText: scenario.message,
                lead: scenario.lead,
                context: scenario.context
            });

            console.log(`${C.cyan}🤖 AMANDA: "${response}"${C.reset}`);

            const evaluation = this.evaluator.evaluate(response, scenario.context);

            this.printEvaluation(evaluation);

            this.results.push({
                scenario: scenario.name,
                userMessage: scenario.message,
                response,
                evaluation
            });

            return evaluation;

        } catch (error) {
            console.error(`${C.red}❌ ERRO: ${error.message}${C.reset}`);
            return null;
        }
    }

    printEvaluation(evaluation) {
        const color = evaluation.score >= 7 ? C.green : evaluation.score >= 5 ? C.yellow : C.red;
        
        console.log(`\n${color}📊 SCORE: ${evaluation.score.toFixed(1)}/10 - ${evaluation.rating}${C.reset}`);
        
        console.log(`\n✅ Pontos Positivos:`);
        Object.entries(evaluation.details.positive)
            .filter(([k, v]) => v.found)
            .forEach(([k, v]) => {
                console.log(`   ${C.green}✓${C.reset} ${v.name} (+${v.score})`);
            });

        console.log(`\n❌ Pontos Negativos:`);
        Object.entries(evaluation.details.negative)
            .filter(([k, v]) => v.found)
            .forEach(([k, v]) => {
                console.log(`   ${C.red}✗${C.reset} ${v.name} (${v.score})`);
            });

        console.log(`\n💡 Sugestões:`);
        evaluation.feedback.forEach(f => {
            if (f.startsWith('✅')) console.log(`   ${C.green}${f}${C.reset}`);
            else if (f.startsWith('❌')) console.log(`   ${C.red}${f}${C.reset}`);
            else console.log(`   ${C.yellow}${f}${C.reset}`);
        });
    }

    generateReport() {
        console.log(`\n${C.cyan}${'='.repeat(70)}${C.reset}`);
        console.log(`${C.cyan}📊 RELATÓRIO FINAL - VENDA PSICOLÓGICA${C.reset}`);
        console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);

        const scores = this.results.map(r => r.evaluation.score);
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const minScore = Math.min(...scores);
        const maxScore = Math.max(...scores);

        console.log(`\n📈 Estatísticas:`);
        console.log(`   Média: ${avgScore.toFixed(1)}/10`);
        console.log(`   Mínimo: ${minScore.toFixed(1)}/10`);
        console.log(`   Máximo: ${maxScore.toFixed(1)}/10`);

        const distribution = {
            excellent: this.results.filter(r => r.evaluation.score >= 9).length,
            good: this.results.filter(r => r.evaluation.score >= 7 && r.evaluation.score < 9).length,
            regular: this.results.filter(r => r.evaluation.score >= 5 && r.evaluation.score < 7).length,
            bad: this.results.filter(r => r.evaluation.score < 5).length
        };

        console.log(`\n🎯 Distribuição:`);
        console.log(`   🟢 Excelente (9-10): ${distribution.excellent}`);
        console.log(`   🟡 Boa (7-8): ${distribution.good}`);
        console.log(`   🟠 Regular (5-6): ${distribution.regular}`);
        console.log(`   🔴 Ruim (<5): ${distribution.bad}`);

        // Melhores e piores
        console.log(`\n🏆 Melhores Respostas:`);
        this.results
            .sort((a, b) => b.evaluation.score - a.evaluation.score)
            .slice(0, 3)
            .forEach((r, i) => {
                console.log(`   ${i+1}. ${r.scenario} (${r.evaluation.score.toFixed(1)})`);
            });

        console.log(`\n⚠️ Precisam Melhorar:`);
        this.results
            .sort((a, b) => a.evaluation.score - b.evaluation.score)
            .slice(0, 3)
            .forEach((r, i) => {
                console.log(`   ${i+1}. ${r.scenario} (${r.evaluation.score.toFixed(1)})`);
            });

        return {
            avgScore,
            distribution,
            results: this.results
        };
    }
}

// ============================================
// 🚀 EXECUÇÃO
// ============================================
async function main() {
    console.log(`${C.cyan}${C.bold}`);
    console.log('🧠 PSYCHOLOGICAL SALES TEST');
    console.log('Avaliando qualidade das respostas da Amanda');
    console.log(`${C.reset}`);

    const tester = new PsychologicalSalesTester();

    for (const scenario of PSYCHOLOGICAL_SCENARIOS) {
        await tester.runTest(scenario);
    }

    const report = tester.generateReport();
    
    // Salva relatório
    const fs = await import('fs/promises');
    const reportPath = `./test-reports/psychological-sales-${Date.now()}.json`;
    await fs.mkdir('./test-reports', { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Relatório salvo: ${reportPath}`);
}

export { PsychologicalSalesTester, PsychologicalSalesEvaluator, PSYCHOLOGICAL_SCENARIOS };

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
