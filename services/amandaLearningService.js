// services/amandaLearningService.js (CRIAR)

import Lead from '../models/Leads.js';
import LearningInsight from '../models/LearningInsight.js';
import Message from '../models/Message.js';

/**
 * 🧹 LIMPA TEXTO DE MENSAGEM
 */
function cleanText(text) {
    if (!text) return '';
    
    return text
        // Remove timestamps (HH:MM, HH:MM:SS)
        .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')
        // Remove datas
        .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '')
        // Remove metadados WhatsApp
        .replace(/wa-wordmark-refreshed:/gi, '')
        .replace(/\[.*?\]/g, '') // Remove [textos entre colchetes]
        .replace(/Clínica Fono Inova:/gi, '')
        .replace(/\+55\s?\d{2}\s?\d{4,5}-?\d{4}/g, '') // Remove telefones
        // Remove múltiplos espaços/quebras
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * ✅ VALIDA SE TEXTO É ÚTIL
 */
function isValidText(text) {
    if (!text || text.length < 3) return false;
    
    // Remove se tiver muito lixo
    const hasJunk = /wa-wordmark|ObjectId|\+55\s?\d{2}|\[\s*\]/i.test(text);
    if (hasJunk) return false;
    
    return true;
}
/**
 * 🧠 ANALISA CONVERSAS HISTÓRICAS E APRENDE PADRÕES
 */
export async function analyzeHistoricalConversations() {
    console.log('🧠 [LEARNING] Iniciando análise histórica...');

    try {
        // 1. BUSCA LEADS QUE VIRARAM PACIENTE
        const successfulLeads = await Lead.find({
            status: 'virou_paciente'
        }).lean();

        console.log(`✅ Encontrados ${successfulLeads.length} leads convertidos`);
        //         ^ ADICIONE ESTE ( AQUI
        if (successfulLeads.length === 0) {
            console.log('⚠️ Nenhum lead convertido encontrado. Aguardando dados...');
            return null;
        }

        const insights = {
            bestOpeningLines: [],
            effectivePriceResponses: [],
            successfulClosingQuestions: [],
            commonObjections: []
        };

        // 2. ANALISA CADA CONVERSA BEM-SUCEDIDA
        for (const lead of successfulLeads) {
            const messages = await Message.find({
                lead: lead._id,
                type: 'text'
            }).sort({ timestamp: 1 }).lean();

            if (messages.length < 2) continue; // Precisa ter pelo menos 2 msgs

            // 🎯 PRIMEIRA RESPOSTA DA AMANDA
            const firstAmandaMsg = messages.find(m => m.direction === 'outbound');
            if (firstAmandaMsg) {
                const existing = insights.bestOpeningLines.find(
                    o => o.text === firstAmandaMsg.content && o.leadOrigin === lead.origin
                );

                if (existing) {
                    existing.usageCount++;
                } else {
                    insights.bestOpeningLines.push({
                        text: firstAmandaMsg.content,
                        leadOrigin: lead.origin,
                        avgConversionTime: calculateConversionTime(lead),
                        conversionRate: 100, // Todos converteram
                        usageCount: 1
                    });
                }
            }

            // 🎯 RESPOSTAS SOBRE PREÇO QUE CONVERTERAM
            const priceMessages = messages.filter(m =>
                m.direction === 'outbound' &&
                /pre[cç]o|valor|r\$|real|reais/i.test(m.content)
            );

            priceMessages.forEach(msg => {
                const prevMsg = messages[messages.indexOf(msg) - 1];
                const scenario = determineScenario(messages, msg);

                insights.effectivePriceResponses.push({
                    scenario,
                    response: msg.content,
                    conversionRate: 100
                });
            });

            // 🎯 PERGUNTAS QUE LEVARAM A AGENDAMENTO
            const schedulingKeywords = /agend|marcar|hor[aá]rio|vaga|dispon/i;
            const questionsBeforeScheduling = [];

            for (let i = 0; i < messages.length - 1; i++) {
                const msg = messages[i];
                const nextMsg = messages[i + 1];

                if (msg.direction === 'outbound' &&
                    msg.content.includes('?') &&
                    nextMsg.direction === 'inbound' &&
                    schedulingKeywords.test(nextMsg.content)) {

                    questionsBeforeScheduling.push({
                        question: msg.content,
                        context: lead.status,
                        ledToScheduling: 100
                    });
                }
            }

            insights.successfulClosingQuestions.push(...questionsBeforeScheduling);
        }

        // 3. AGRUPA E CALCULA MÉDIAS
        const aggregated = aggregateInsights(insights);

        // 4. SALVA NO BANCO
        const saved = await LearningInsight.create({
            type: 'conversation_patterns',
            data: aggregated,
            leadsAnalyzed: successfulLeads.length,
            conversationsAnalyzed: successfulLeads.length,
            dateRange: {
                from: new Date(Math.min(...successfulLeads.map(l => l.createdAt))),
                to: new Date()
            }
        });

        console.log('✅ [LEARNING] Insights salvos:', saved._id);
        console.log(`📊 Aberturas únicas: ${aggregated.bestOpeningLines.length}`);
        console.log(`💰 Respostas de preço: ${aggregated.effectivePriceResponses.length}`);
        console.log(`❓ Perguntas de fechamento: ${aggregated.successfulClosingQuestions.length}`);

        return saved;

    } catch (error) {
        console.error('❌ [LEARNING] Erro na análise:', error);
        return null;
    }
}

/**
 * 🎯 BUSCA INSIGHTS MAIS RECENTES
 */
export async function getLatestInsights() {
    return await LearningInsight.findOne({ type: 'conversation_patterns' })
        .sort({ generatedAt: -1 })
        .lean();
}

/**
 * 📊 AGREGA INSIGHTS SIMILARES
 */
function aggregateInsights(insights) {
    // Agrupa aberturas por origem
    const openingsByOrigin = {};
    insights.bestOpeningLines.forEach(line => {
        const key = `${line.leadOrigin}`;
        if (!openingsByOrigin[key]) openingsByOrigin[key] = [];
        openingsByOrigin[key].push(line);
    });

    // Pega as TOP 3 mais usadas de cada origem
    const topOpenings = Object.entries(openingsByOrigin).flatMap(([origin, lines]) => {
        return lines
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, 3);
    });

    // Agrupa respostas de preço por cenário
    const priceByScenario = {};
    insights.effectivePriceResponses.forEach(resp => {
        if (!priceByScenario[resp.scenario]) priceByScenario[resp.scenario] = [];
        priceByScenario[resp.scenario].push(resp);
    });

    const topPriceResponses = Object.entries(priceByScenario).flatMap(([scenario, resps]) => {
        // Remove duplicatas exatas
        const unique = resps.filter((r, i, arr) =>
            arr.findIndex(x => x.response === r.response) === i
        );
        return unique.slice(0, 2); // Top 2 por cenário
    });

    // Remove perguntas duplicadas
    const uniqueQuestions = [];
    insights.successfulClosingQuestions.forEach(q => {
        if (!uniqueQuestions.find(x => x.question === q.question)) {
            uniqueQuestions.push(q);
        }
    });

    return {
        bestOpeningLines: topOpenings,
        effectivePriceResponses: topPriceResponses,
        successfulClosingQuestions: uniqueQuestions.slice(0, 10) // Top 10
    };
}

/**
 * ⏱️ CALCULA TEMPO ATÉ CONVERSÃO (em horas)
 */
function calculateConversionTime(lead) {
    if (!lead.createdAt || !lead.updatedAt) return 0;
    const diff = new Date(lead.updatedAt) - new Date(lead.createdAt);
    return Math.round(diff / (1000 * 60 * 60)); // horas
}

/**
 * 🎯 DETERMINA CENÁRIO DA CONVERSA
 */
function determineScenario(messages, currentMsg) {
    const index = messages.indexOf(currentMsg);

    if (index <= 2) return 'first_contact';
    if (index >= 10) return 'engaged';

    const daysSinceFirst = (currentMsg.timestamp - messages[0].timestamp) / (1000 * 60 * 60 * 24);
    if (daysSinceFirst > 3) return 'cold_lead';

    return 'returning';
}

export default analyzeHistoricalConversations;