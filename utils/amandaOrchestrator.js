// /src/utils/amandaOrchestrator.js
/* =========================================================================
   AMANDA ORCHESTRATOR - Integra IA + Sistema de Intenções
   ========================================================================= */

import { getAmandaResponse } from './amandaIntents.js';

/**
 * Orquestrador principal - decide a melhor fonte de resposta
 */
export async function getOptimizedAmandaResponse(userMessage, context = {}) {
    const normalized = userMessage || "";
    const { useAIFallback = true, forceAI = false, forceIntents = false } = context;

    if (forceIntents) {
        const intentResponse = getAmandaResponse(normalized, true);
        return intentResponse?.message || "Desculpe, tive um problema. Pode repetir? 💚";
    }

    // 1) Sempre tente intenções primeiro
    const intentResult = getAmandaResponse(normalized, useAIFallback);
    if (intentResult?.confidence >= 0.3 && !forceAI) {
        return intentResult.message;
    }

    // 2) IA principal
    try {
        const aiText = await callAIService({
            userText: normalized,
            context
        });
        return aiText;
    } catch (err) {
        const fallback = getAmandaResponse(normalized, false); // não bloqueie por limiar aqui
        return fallback?.message || "Estou com dificuldades técnicas. Pode reformular sua pergunta? 💚";
    }
}


export default getOptimizedAmandaResponse;
