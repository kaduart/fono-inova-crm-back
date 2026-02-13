
import LearningInsight from '../models/LearningInsight.js';

// Cache aumentado para 4 horas (sugestão de performance)
const CACHE_TTL = 4 * 60 * 60 * 1000;
let cache = {
    data: null,
    timestamp: 0
};

/**
 * 🧠 BUSCA INSIGHTS ATIVOS PARA O PROMPT
 * Retorna os melhores padrões aprendidos para serem injetados no contexto.
 */
export async function getActiveLearnings() {
    // 🛡️ Kill Switch: Se desativado no .env, não injeta nada
    if (process.env.DISABLE_AUTO_LEARNING === 'true') {
        return null;
    }

    // 1. Verifica cache
    if (cache.data && (Date.now() - cache.timestamp < CACHE_TTL)) {
        return cache.data;
    }

    try {
        // 2. Busca o insight mais recente do tipo 'conversation_patterns'
        // (Assumindo que runLearningAnalysis.js gera um doc gigante com tudo)
        const latestInsight = await LearningInsight.findOne({
            type: 'conversation_patterns'
        })
            .sort({ generatedAt: -1 })
            .lean();

        if (!latestInsight || !latestInsight.data) {
            return null;
        }

        const data = latestInsight.data;

        // 3. Processa e filtra os melhores (Top 3 de cada)
        const learnings = {
            // Aberturas que mais converteram
            openings: (data.bestOpeningLines || [])
                .sort((a, b) => b.usageCount - a.usageCount)
                .slice(0, 3)
                .map(i => ({ text: i.text, origin: i.leadOrigin })),

            // Respostas de preço validadas
            priceHandling: (data.effectivePriceResponses || [])
                .slice(0, 3) // Já vem filtrado do learning service
                .map(i => ({ text: i.response, scenario: i.scenario })),

            // Perguntas de fechamento
            closings: (data.successfulClosingQuestions || [])
                .slice(0, 3)
                .map(i => ({ text: i.question, stage: i.context })),

            // ⛔ O que não fazemos (Negative Scope)
            // 🛡️ SAFETY: Apenas itens verificados manualmente ou com alta confiança
            negativeScope: (data.negativeScope || [])
                .filter(i => i.verified === true)
                .slice(0, 5)
                .map(i => ({ term: i.term, phrase: i.phrase }))
        };

        // 4. Atualiza cache com timestamp
        cache = {
            data: learnings,
            timestamp: Date.now()
        };

        console.log(`🧠 [LEARNING] Cache atualizado com sucesso (${new Date().toLocaleTimeString()})`);
        return learnings;

    } catch (error) {
        console.error('❌ [LEARNING] Erro ao buscar insights:', error.message);
        return null; // Falha silenciosa para não quebrar o fluxo
    }
}

/**
 * 🧹 LIMPA CACHE (Útil para forçar atualização)
 */
export function clearLearningCache() {
    cache = { data: null, timestamp: 0 };
    console.log('🧹 [LEARNING] Cache limpo manualmente.');
}

export default {
    getActiveLearnings,
    clearLearningCache
};
