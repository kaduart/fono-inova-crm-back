// services/amandaLearningService.js

import Lead from '../models/Leads.js';
import LearningInsight from '../models/LearningInsight.js';
import Message from '../models/Message.js';

/**
 * 🧹 LIMPA TEXTO DE MENSAGEM
 */
function cleanText(text) {
    if (!text) return '';

    return String(text)
        // Remove timestamps (HH:MM, HH:MM:SS)
        .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')
        // Remove datas (dd/mm/aaaa ou dd/mm/aa)
        .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '')
        // Remove metadados WhatsApp / colchetes
        .replace(/wa-wordmark-refreshed:/gi, '')
        .replace(/\[.*?\]/g, '')
        // Remove identificação da clínica
        .replace(/Clínica Fono Inova:/gi, '')
        // Remove telefones
        .replace(/\+55\s?\d{2}\s?\d{4,5}-?\d{4}/g, '')
        // Normaliza espaços / quebras
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * ✅ VALIDA SE TEXTO É ÚTIL
 */
function isValidText(text) {
    if (!text) return false;

    const t = String(text).trim();
    if (t.length < 3) return false;

    // Muito “lixo” técnico?
    const hasJunk = /wa-wordmark|ObjectId|\+55\s?\d{2}|\[\s*\]/i.test(t);
    if (hasJunk) return false;

    return true;
}

/**
 * ⏱️ CALCULA TEMPO ATÉ CONVERSÃO (em horas)
 */
function calculateConversionTime(lead) {
    if (!lead?.createdAt || !lead?.updatedAt) return 0;
    const diff = new Date(lead.updatedAt) - new Date(lead.createdAt);
    return Math.round(diff / (1000 * 60 * 60));
}

/**
 * 🎯 DETERMINA CENÁRIO DA CONVERSA (para respostas de preço)
 */
function determineScenario(messages, currentMsg) {
    const index = messages.findIndex(m => m._id?.toString() === currentMsg._id?.toString());

    if (index <= 2) return 'first_contact';
    if (index >= 10) return 'engaged';

    const firstTs = messages[0]?.timestamp ? new Date(messages[0].timestamp) : null;
    const currentTs = currentMsg.timestamp ? new Date(currentMsg.timestamp) : null;

    if (firstTs && currentTs) {
        const daysSinceFirst = (currentTs - firstTs) / (1000 * 60 * 60 * 24);
        if (daysSinceFirst > 3) return 'cold_lead';
    }

    return 'returning';
}

/**
 * 📊 AGREGA INSIGHTS SIMILARES (TOPs para uso na IA)
 */
function aggregateInsights(insights) {
    // ---------------------------
    // Aberturas por origem
    // ---------------------------
    const openingsByOrigin = {};
    insights.bestOpeningLines.forEach(line => {
        const key = line.leadOrigin || 'desconhecida';
        if (!openingsByOrigin[key]) openingsByOrigin[key] = [];
        openingsByOrigin[key].push(line);
    });

    // TOP 3 por origem
    const topOpenings = Object.values(openingsByOrigin).flatMap(lines =>
        lines
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, 3)
    );

    // ---------------------------
    // Respostas de preço por cenário
    // ---------------------------
    const priceByScenario = {};
    insights.effectivePriceResponses.forEach(resp => {
        const key = resp.scenario || 'generic';
        if (!priceByScenario[key]) priceByScenario[key] = [];
        priceByScenario[key].push(resp);
    });

    const topPriceResponses = Object.entries(priceByScenario).flatMap(([scenario, resps]) => {
        // Remove duplicatas exatas
        const unique = resps.filter((r, i, arr) =>
            arr.findIndex(x => x.response === r.response) === i
        );
        return unique.slice(0, 2); // Top 2 por cenário
    });

    // ---------------------------
    // Perguntas de fechamento (sem duplicar)
    // ---------------------------
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
 * 🧠 ANALISA CONVERSAS HISTÓRICAS E APRENDE PADRÕES
 * - Só olha para leads com status "virou_paciente"
 * - Gera 1 documento de LearningInsight com padrões agregados
 */
export async function analyzeHistoricalConversations() {
    console.log('🧠 [LEARNING] Iniciando análise histórica...');

    try {
        // 1) Leads que converteram
        const successfulLeads = await Lead.find({
            status: 'virou_paciente'
        }).lean();

        console.log(`✅ Encontrados ${successfulLeads.length} leads convertidos`);

        if (successfulLeads.length === 0) {
            console.log('⚠️ Nenhum lead convertido encontrado. Aguardando dados...');
            return null;
        }

        const insights = {
            bestOpeningLines: [],
            effectivePriceResponses: [],
            successfulClosingQuestions: [],
            commonObjections: [] // reservado pra futuro
        };

        // 2) Para cada lead convertido, ler conversas
        for (const lead of successfulLeads) {
            const messages = await Message.find({
                lead: lead._id,
                type: 'text'
            })
                .sort({ timestamp: 1 })
                .lean();

            if (!messages || messages.length < 2) continue;

            // ------------ Aberturas da Amanda (primeira saída nossa) ------------
            const firstAmandaMsg = messages.find(m => m.direction === 'outbound');
            if (firstAmandaMsg) {
                const cleaned = cleanText(firstAmandaMsg.content || firstAmandaMsg.text || '');
                if (isValidText(cleaned)) {
                    const existing = insights.bestOpeningLines.find(
                        o => o.text === cleaned && o.leadOrigin === lead.origin
                    );

                    if (existing) {
                        existing.usageCount++;
                    } else {
                        insights.bestOpeningLines.push({
                            text: cleaned,
                            leadOrigin: lead.origin || 'desconhecida',
                            avgConversionTime: calculateConversionTime(lead),
                            conversionRate: 100,
                            usageCount: 1
                        });
                    }
                }
            }

            // ------------ Respostas sobre preço que aparecem em leads que fecharam ------------
            const priceMessages = messages.filter(m =>
                m.direction === 'outbound' &&
                /pre[cç]o|valor|r\$|real|reais/i.test(m.content || m.text || '')
            );

            priceMessages.forEach(msg => {
                const cleaned = cleanText(msg.content || msg.text || '');
                if (!isValidText(cleaned)) return;

                const scenario = determineScenario(messages, msg);

                insights.effectivePriceResponses.push({
                    scenario,
                    response: cleaned,
                    conversionRate: 100
                });
            });

            // ------------ Perguntas que antecedem intenção de agendar ------------
            const schedulingKeywords = /agend|marcar|hor[aá]rio|vaga|dispon/i;
            const questionsBeforeScheduling = [];

            for (let i = 0; i < messages.length - 1; i++) {
                const msg = messages[i];
                const nextMsg = messages[i + 1];

                if (
                    msg.direction === 'outbound' &&
                    (msg.content || msg.text || '').includes('?') &&
                    nextMsg.direction === 'inbound' &&
                    schedulingKeywords.test(nextMsg.content || nextMsg.text || '')
                ) {
                    const cleanedQ = cleanText(msg.content || msg.text || '');
                    if (!isValidText(cleanedQ)) continue;

                    questionsBeforeScheduling.push({
                        question: cleanedQ,
                        context: lead.status,
                        ledToScheduling: 100
                    });
                }
            }

            insights.successfulClosingQuestions.push(...questionsBeforeScheduling);
        }

        // 3) Agrega e simplifica (TOPs)
        const aggregated = aggregateInsights(insights);

        // 4) Data inicial de referência (segura)
        const createdList = successfulLeads
            .map(l => l.createdAt)
            .filter(Boolean)
            .map(d => new Date(d).getTime());

        const from = createdList.length
            ? new Date(Math.min(...createdList))
            : null;

        // 5) Salva no Mongo (LearningInsight)
        const saved = await LearningInsight.create({
            type: 'conversation_patterns',
            data: aggregated,
            leadsAnalyzed: successfulLeads.length,
            conversationsAnalyzed: successfulLeads.length,
            dateRange: {
                from,
                to: new Date()
            },
            generatedAt: new Date()
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

export default analyzeHistoricalConversations;
