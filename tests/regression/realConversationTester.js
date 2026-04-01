/**
 * 🎯 Real Conversation Tester - Teste com Dados Reais
 * 
 * Extrai conversas do MongoDB e avalia:
 * 1. Se Amanda responde corretamente
 * 2. Se preenche campos corretamente
 * 3. Se usa "venda psicológica" (acolhedora, não forçada)
 * 4. Se recupera contexto
 * 5. Se converte leads
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import { enrichLeadContext } from '../services/leadContext.js';
import { deriveFlagsFromText } from '../utils/flagsDetector.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';

// ============================================
// 🎨 CORES PARA CONSOLE
// ============================================
const C = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bold: '\x1b[1m'
};

function color(text, color) {
    return `${C[color]}${text}${C.reset}`;
}

// ============================================
// 📊 SISTEMA DE AVALIAÇÃO DE RESPOSTAS
// ============================================
class ResponseEvaluator {
    constructor() {
        this.scores = [];
    }

    // Avalia se a resposta é "venda psicológica" (acolhedora) ou forçada
    evaluatePsychologicalSales(response, context) {
        const checks = {
            // ✅ BOM: Acolhimento emocional
            hasEmpathy: /\b(entendo|compreendo|sei que|deve ser|imagino|lidar|acolh|apoio|cuidado)\b/i.test(response),
            
            // ✅ BOM: Linguagem suave, não agressiva
            isSoft: !/\b(agora|tem que|precisa|obrigatório|só tem essa|última chance)\b/i.test(response),
            
            // ✅ BOM: Pergunta permissiva (não impositiva)
            asksPermission: /\b(pode ser|se quiser|se preferir|gostaria|quer que|posso)\b/i.test(response),
            
            // ✅ BOM: Oferece opções
            offersOptions: /\b(ou|também|alternativa|opção|se preferir)\b/i.test(response),
            
            // ❌ RUIM: Pressão/urgência artificial
            hasPressure: /\b(corre|rápido|só hoje|última vaga|vai acabar|esgotando)\b/i.test(response),
            
            // ❌ RUIM: Linguagem muito comercial/vendedora
            isTooSalesy: /\b(oportunidade única|melhor preço|promoção|desconto exclusivo|não perca)\b/i.test(response),
            
            // ✅ BOM: Contextualiza com dados do paciente
            isPersonalized: context.patientName && response.includes(context.patientName.split(' ')[0]),
            
            // ✅ BOM: Menciona área terapêutica (contexto recuperado)
            mentionsArea: context.therapyArea && new RegExp(context.therapyArea, 'i').test(response)
        };

        const goodPoints = ['hasEmpathy', 'isSoft', 'asksPermission', 'offersOptions', 'isPersonalized', 'mentionsArea']
            .filter(k => checks[k]).length;
        
        const badPoints = ['hasPressure', 'isTooSalesy'].filter(k => checks[k]).length;
        
        const score = Math.max(0, Math.min(10, (goodPoints * 2) - (badPoints * 3)));
        
        return {
            score,
            rating: score >= 8 ? 'EXCELENTE' : score >= 6 ? 'BOA' : score >= 4 ? 'REGULAR' : 'RUIM',
            checks,
            feedback: this.generateFeedback(checks, score)
        };
    }

    generateFeedback(checks, score) {
        const feedback = [];
        if (!checks.hasEmpathy) feedback.push('Faltou empatia/acolhimento');
        if (!checks.isSoft) feedback.push('Linguagem muito direta/agressiva');
        if (!checks.asksPermission) feedback.push('Não perguntou permissão');
        if (!checks.offersOptions) feedback.push('Não ofereceu opções');
        if (checks.hasPressure) feedback.push('Pressão excessiva');
        if (checks.isTooSalesy) feedback.push('Muito comercial');
        if (!checks.isPersonalized) feedback.push('Não personalizou com nome');
        if (!checks.mentionsArea) feedback.push('Não mencionou área terapêutica');
        
        if (feedback.length === 0) return 'Resposta exemplar!';
        return feedback.join(' | ');
    }

    // Avalia se a resposta está correta para o contexto
    evaluateCorrectness(response, userIntent, missingFields) {
        const checks = {
            // Perguntou o que faltava?
            asksMissingField: missingFields.length > 0 && 
                missingFields.some(f => this.fieldQuestioned(f, response)),
            
            // Respondeu dúvida do usuário?
            answersQuestion: this.answersUserQuestion(userIntent, response),
            
            // Próximo passo claro?
            hasClearNextStep: /\b(qual|pode|gostaria|me conta|para eu)\b/i.test(response),
            
            // Não repetitiva?
            notRepetitive: !/\b(já disse|como eu disse|novamente|mais uma vez)\b/i.test(response)
        };

        return {
            correct: checks.asksMissingField || checks.answersQuestion,
            checks,
            missing: missingFields
        };
    }

    fieldQuestioned(field, response) {
        const patterns = {
            name: /nome.*completo|qual.*nome|como.*(se chama|se chama)/i,
            age: /idade|anos|quantos.*anos/i,
            therapyArea: /qual.*(área|especialidade|terapia)|precisa de qual/i,
            period: /(manhã|tarde|noite|período|quando|horário)/i,
            complaint: /queixa|preocupação|o que.*(acontece|sucede)|motivo/i
        };
        return patterns[field]?.test(response) || false;
    }

    answersUserQuestion(intent, response) {
        if (intent.asksPrice) return /R\$|\d+.*(reais|valor|preço)/i.test(response);
        if (intent.asksLocation) return /(endereço|onde|fica|local|Anápolis|Minas Gerais)/i.test(response);
        if (intent.asksPlans) return /(plano|convênio|reembolso|unimed|amil)/i.test(response);
        return true; // Se não detectou intenção específica, assume OK
    }
}

// ============================================
// 🔍 EXTRATOR DE CONVERSAS REAIS
// ============================================
class ConversationMiner {
    async findConvertibleConversations(limit = 50) {
        console.log(color('\n🔍 Minerando conversas convertidas do MongoDB...', 'cyan'));
        
        // Busca leads que viraram pacientes
        const convertedLeads = await Lead.find({
            convertedToPatient: { $exists: true },
            interactions: { $exists: true, $not: { $size: 0 } }
        })
        .limit(limit)
        .select('_id name contact therapyArea patientInfo interactions createdAt convertedToPatient')
        .lean();

        console.log(color(`✅ Encontrados ${convertedLeads.length} leads convertidos`, 'green'));
        
        return convertedLeads;
    }

    async findLostConversations(limit = 50) {
        console.log(color('\n🔍 Minerando conversas perdidas...', 'cyan'));
        
        // Busca leads que não converteram mas tiveram interação
        const lostLeads = await Lead.find({
            status: { $in: ['perdido', 'sem_interesse', 'nao_respondeu'] },
            interactions: { $exists: true, $not: { $size: 0 } },
            'interactions.3': { $exists: true }  // Pelo menos 4 interações
        })
        .limit(limit)
        .select('_id name status contact interactions createdAt')
        .lean();

        console.log(color(`✅ Encontrados ${lostLeads.length} leads perdidos`, 'yellow'));
        
        return lostLeads;
    }

    async getFullConversation(leadId) {
        const messages = await Message.find({
            lead: leadId,
            type: 'text'
        })
        .sort({ timestamp: 1 })
        .select('content direction timestamp from')
        .lean();

        return messages;
    }

    async findMultiMessageConversations(minMessages = 5, limit = 30) {
        console.log(color('\n🔍 Buscando conversas longas (ricas)...', 'cyan'));
        
        const pipeline = [
            {
                $match: {
                    type: 'text',
                    direction: 'inbound'
                }
            },
            {
                $group: {
                    _id: '$lead',
                    messageCount: { $sum: 1 },
                    messages: {
                        $push: {
                            content: '$content',
                            direction: '$direction',
                            timestamp: '$timestamp'
                        }
                    }
                }
            },
            {
                $match: {
                    messageCount: { $gte: minMessages }
                }
            },
            { $sort: { messageCount: -1 } },
            { $limit: limit }
        ];

        const results = await Message.aggregate(pipeline);
        console.log(color(`✅ Encontradas ${results.length} conversas com ${minMessages}+ mensagens`, 'green'));
        
        return results;
    }
}

// ============================================
// 🎮 SIMULADOR DE CONVERSA
// ============================================
class ConversationSimulator {
    constructor() {
        this.evaluator = new ResponseEvaluator();
        this.results = [];
    }

    async simulateConversation(lead, messages, options = {}) {
        const conversationLog = [];
        let currentLead = { ...lead };
        
        console.log(color(`\n${'='.repeat(70)}`, 'magenta'));
        console.log(color(`🎮 SIMULANDO: Lead ${lead.name || 'Sem nome'} (${messages.length} msgs)`, 'magenta'));
        console.log(color(`💾 Estado inicial:`, 'cyan'));
        console.log(`   Área: ${currentLead.therapyArea || '❌ Não definida'}`);
        console.log(`   Paciente: ${currentLead.patientInfo?.fullName || '❌ Não definido'}`);
        console.log(`   Idade: ${currentLead.patientInfo?.age || '❌ Não definida'}`);
        console.log(color(`${'='.repeat(70)}`, 'magenta'));

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            
            // Só processa mensagens do usuário
            if (msg.direction !== 'inbound') continue;

            console.log(color(`\n📨 USUÁRIO: "${msg.content.substring(0, 60)}${msg.content.length > 60 ? '...' : ''}"`, 'blue'));
            
            const flags = deriveFlagsFromText(msg.content);
            
            try {
                const startTime = Date.now();
                const response = await getOptimizedAmandaResponse({
                    content: msg.content,
                    userText: msg.content,
                    lead: currentLead,
                    context: { source: 'test-simulation' }
                });
                const duration = Date.now() - startTime;

                // Avalia a resposta
                const psychEval = this.evaluator.evaluatePsychologicalSales(response, {
                    patientName: currentLead.patientInfo?.fullName,
                    therapyArea: currentLead.therapyArea
                });

                const correctness = this.evaluator.evaluateCorrectness(
                    response,
                    flags,
                    this.detectMissingFields(currentLead)
                );

                console.log(color(`🤖 AMANDA: "${response?.substring(0, 80)}${response?.length > 80 ? '...' : ''}"`, 'green'));
                console.log(color(`   ⏱️ ${duration}ms | Venda Psicológica: ${psychEval.rating} (${psychEval.score}/10)`, 
                    psychEval.score >= 7 ? 'green' : psychEval.score >= 5 ? 'yellow' : 'red'));
                
                if (psychEval.score < 8) {
                    console.log(color(`   💡 ${psychEval.feedback}`, 'yellow'));
                }

                // Atualiza estado simulado do lead (como se fosse salvo no banco)
                currentLead = this.simulateLeadUpdate(currentLead, msg.content, flags);

                conversationLog.push({
                    turn: i + 1,
                    userMessage: msg.content,
                    amandaResponse: response,
                    duration,
                    psychologicalScore: psychEval,
                    correctness,
                    flags,
                    leadState: {
                        therapyArea: currentLead.therapyArea,
                        name: currentLead.patientInfo?.fullName,
                        age: currentLead.patientInfo?.age
                    }
                });

            } catch (error) {
                console.error(color(`❌ ERRO: ${error.message}`, 'red'));
                conversationLog.push({
                    turn: i + 1,
                    userMessage: msg.content,
                    error: error.message
                });
            }

            // Delay entre mensagens
            if (options.delay) {
                await new Promise(r => setTimeout(r, options.delay));
            }
        }

        // Resultado final
        const finalResult = {
            leadId: lead._id,
            leadName: lead.name,
            totalTurns: conversationLog.length,
            avgPsychScore: conversationLog.reduce((a, r) => a + (r.psychologicalScore?.score || 0), 0) / conversationLog.length,
            avgResponseTime: conversationLog.reduce((a, r) => a + (r.duration || 0), 0) / conversationLog.length,
            errors: conversationLog.filter(r => r.error).length,
            finalState: conversationLog[conversationLog.length - 1]?.leadState,
            conversation: conversationLog
        };

        this.results.push(finalResult);
        
        this.printSummary(finalResult);
        
        return finalResult;
    }

    detectMissingFields(lead) {
        const missing = [];
        if (!lead.therapyArea) missing.push('therapyArea');
        if (!lead.patientInfo?.fullName) missing.push('name');
        if (!lead.patientInfo?.age) missing.push('age');
        if (!lead.pendingPreferredPeriod) missing.push('period');
        return missing;
    }

    simulateLeadUpdate(lead, message, flags) {
        // Simula extração de dados (simplificado)
        const updated = { ...lead };
        
        if (!updated.patientInfo) updated.patientInfo = {};
        
        // Extrai nome
        const nameMatch = message.match(/(?:sou|me chamo|nome [ée])\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);
        if (nameMatch && !updated.patientInfo.fullName) {
            updated.patientInfo.fullName = nameMatch[1];
        }
        
        // Extrai idade
        const ageMatch = message.match(/(\d+)\s*(anos?|meses?)/i);
        if (ageMatch && !updated.patientInfo.age) {
            updated.patientInfo.age = parseInt(ageMatch[1]);
        }
        
        // Extrai área
        if (flags.therapyArea && !updated.therapyArea) {
            updated.therapyArea = flags.therapyArea;
        }
        
        return updated;
    }

    printSummary(result) {
        console.log(color(`\n📊 RESUMO DA CONVERSA`, 'cyan'));
        console.log(`   Turnos: ${result.totalTurns}`);
        console.log(`   Score Médio (Venda Psicológica): ${result.avgPsychScore.toFixed(1)}/10`);
        console.log(`   Tempo Médio de Resposta: ${result.avgResponseTime.toFixed(0)}ms`);
        console.log(`   Erros: ${result.errors}`);
        console.log(`   Estado Final:`, result.finalState);
        console.log(color(`${'='.repeat(70)}\n`, 'magenta'));
    }

    generateFinalReport() {
        console.log(color('\n' + '='.repeat(70), 'cyan'));
        console.log(color('📊 RELATÓRIO FINAL - TESTE COM DADOS REAIS', 'cyan'));
        console.log(color('='.repeat(70), 'cyan'));

        const total = this.results.length;
        const avgScore = this.results.reduce((a, r) => a + r.avgPsychScore, 0) / total;
        const avgTime = this.results.reduce((a, r) => a + r.avgResponseTime, 0) / total;
        const totalErrors = this.results.reduce((a, r) => a + r.errors, 0);

        console.log(`\n📈 Estatísticas Gerais:`);
        console.log(`   Conversas testadas: ${total}`);
        console.log(`   Score médio (Venda Psicológica): ${avgScore.toFixed(2)}/10`);
        console.log(`   Tempo médio de resposta: ${avgTime.toFixed(0)}ms`);
        console.log(`   Total de erros: ${totalErrors}`);

        // Classifica por qualidade
        const excellent = this.results.filter(r => r.avgPsychScore >= 8).length;
        const good = this.results.filter(r => r.avgPsychScore >= 6 && r.avgPsychScore < 8).length;
        const regular = this.results.filter(r => r.avgPsychScore >= 4 && r.avgPsychScore < 6).length;
        const bad = this.results.filter(r => r.avgPsychScore < 4).length;

        console.log(`\n🎯 Distribuição de Qualidade:`);
        console.log(color(`   🟢 Excelente (8-10): ${excellent} (${(excellent/total*100).toFixed(1)}%)`, 'green'));
        console.log(color(`   🟡 Boa (6-7): ${good} (${(good/total*100).toFixed(1)}%)`, 'yellow'));
        console.log(color(`   🟠 Regular (4-5): ${regular} (${(regular/total*100).toFixed(1)}%)`, 'yellow'));
        console.log(color(`   🔴 Ruim (0-3): ${bad} (${(bad/total*100).toFixed(1)}%)`, 'red'));

        // Problemas mais comuns
        console.log(`\n⚠️  Problemas Identificados:`);
        this.identifyCommonIssues();

        return {
            total,
            avgScore,
            avgTime,
            distribution: { excellent, good, regular, bad },
            results: this.results
        };
    }

    identifyCommonIssues() {
        const issues = {};
        
        this.results.forEach(result => {
            result.conversation.forEach(turn => {
                if (turn.psychologicalScore?.feedback && turn.psychologicalScore.feedback !== 'Resposta exemplar!') {
                    const key = turn.psychologicalScore.feedback;
                    issues[key] = (issues[key] || 0) + 1;
                }
            });
        });

        const sortedIssues = Object.entries(issues)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        sortedIssues.forEach(([issue, count]) => {
            console.log(`   - ${issue}: ${count} ocorrências`);
        });
    }
}

// ============================================
// 🚀 EXECUÇÃO PRINCIPAL
// ============================================
async function main() {
    console.log(color('🎯 REAL CONVERSATION TESTER', 'cyan'));
    console.log(color('Testando Amanda com dados reais do MongoDB\n', 'cyan'));

    // Conecta ao MongoDB
    console.log(color('🔌 Conectando ao MongoDB...', 'yellow'));
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
    console.log(color('✅ Conectado\n', 'green'));

    const miner = new ConversationMiner();
    const simulator = new ConversationSimulator();

    try {
        const mode = process.env.TEST_MODE || 'converted';
        let leads = [];

        if (mode === 'converted') {
            leads = await miner.findConvertibleConversations(10);
        } else if (mode === 'lost') {
            leads = await miner.findLostConversations(10);
        } else if (mode === 'long') {
            const conversations = await miner.findMultiMessageConversations(5, 10);
            // Busca dados completos dos leads
            for (const conv of conversations) {
                const lead = await Lead.findById(conv._id).lean();
                if (lead) {
                    lead.messages = conv.messages;
                    leads.push(lead);
                }
            }
        }

        console.log(color(`\n🎮 Iniciando simulação de ${leads.length} conversas...\n`, 'cyan'));

        for (const lead of leads) {
            let messages;
            
            if (lead.messages) {
                messages = lead.messages;
            } else {
                messages = await miner.getFullConversation(lead._id);
            }

            if (messages.length >= 3) {
                await simulator.simulateConversation(lead, messages, { delay: 0 });
            }
        }

        // Relatório final
        const report = simulator.generateFinalReport();
        
        // Salva relatório
        const reportPath = `./test-reports/conversation-test-${Date.now()}.json`;
        await import('fs/promises').then(fs => 
            fs.writeFile(reportPath, JSON.stringify(report, null, 2))
        );
        console.log(color(`\n💾 Relatório salvo em: ${reportPath}`, 'cyan'));

    } catch (error) {
        console.error(color(`\n❌ Erro: ${error.message}`, 'red'));
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        console.log(color('\n👋 Desconectado', 'cyan'));
    }
}

// Exporta
export { ConversationMiner, ConversationSimulator, ResponseEvaluator };

// Roda se chamado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
