// /src/utils/amandaOrchestrator.js
/* =========================================================================
   AMANDA ORCHESTRATOR - Integra IA + Sistema de Intenções
   ========================================================================= */

import { getOptimizedAmandaResponse as callAIService } from './aiAmandaService.js';
import { getAmandaResponse } from './amandaIntents.js';

/**
 * Orquestrador principal - decide a melhor fonte de resposta
 */
export async function getOptimizedAmandaResponse(userMessage, context = {}) {
    const normalized = userMessage || ""; // Normalização removida - já é feita nas funções chamadas

    const {
        useAIFallback = true,
        forceAI = false,
        forceIntents = false
    } = context;

    // 1. Forçar intenções (para testes ou cenários específicos)
    if (forceIntents) {
        const intentResponse = getAmandaResponse(normalized, true);
        return intentResponse?.message || "Desculpe, tive um problema. Pode repetir? 💚";
    }

    // 2. Tentar sistema de intenções primeiro (rápido e consistente)
    if (!forceAI) {
        const intentResponse = getAmandaResponse(normalized, useAIFallback);
        if (intentResponse) {
            console.log(`🎯 [INTENTS] ${intentResponse.intent} (${intentResponse.confidence})`);
            return intentResponse.message;
        }
    }

    // 3. Usar IA principal para casos complexos
    try {
        console.log('🤖 [AI] Processando com IA...');
        const aiResponse = await callAIService(normalized, { context });
        return aiResponse;
    } catch (error) {
        console.error('❌ [AI] Erro, usando fallback:', error);

        const fallbackResponse = getAmandaResponse(normalized, true);
        return fallbackResponse?.message || "Estou com dificuldades técnicas. Pode reformular sua pergunta? 💚";
    }
}

export default {
    getOptimizedAmandaResponse
};