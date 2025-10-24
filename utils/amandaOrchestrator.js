// /src/utils/amandaOrchestrator.js
/* =========================================================================
   AMANDA ORCHESTRATOR - Integra IA + Sistema de Intenções
   ========================================================================= */

import { getAmandaResponse } from './amandaIntents.js';
import { callAIService } from './amandaService.js'; // Seu serviço atual

/**
 * Orquestrador principal - decide a melhor fonte de resposta
 */
export async function getOptimizedAmandaResponse(userMessage, context = {}) {
    const {
        useAIFallback = true,
        forceAI = false,
        forceIntents = false
    } = context;

    // 1. Forçar intenções (para testes ou cenários específicos)
    if (forceIntents) {
        const intentResponse = getAmandaResponse(userMessage, true);
        return intentResponse?.message || "Desculpe, tive um problema. Pode repetir? 💚";
    }

    // 2. Tentar sistema de intenções primeiro (rápido e consistente)
    if (!forceAI) {
        const intentResponse = getAmandaResponse(userMessage, useAIFallback);
        if (intentResponse) {
            console.log(`🎯 [INTENTS] ${intentResponse.intent} (${intentResponse.confidence})`);
            return intentResponse.message;
        }
    }

    // 3. Usar IA principal para casos complexos
    try {
        console.log('🤖 [AI] Processando com IA...');
        const aiResponse = await callAIService(userMessage);
        return aiResponse;
    } catch (error) {
        console.error('❌ [AI] Erro, usando fallback:', error);

        // Fallback para intenções em caso de erro na IA
        const fallbackResponse = getAmandaResponse(userMessage, true);
        return fallbackResponse?.message || "Estou com dificuldades técnicas. Pode reformular sua pergunta? 💚";
    }
}

/**
 * Versão síncrona para respostas instantâneas
 */
export function getQuickAmandaResponse(userMessage) {
    return getAmandaResponse(userMessage, true)?.message || null;
}

/* =========================================================================
   CONFIGURAÇÕES DE PERFORMANCE
   ========================================================================= */

export const ORCHESTRATOR_CONFIG = {
    // Confiança mínima para usar intenções ao invés de IA
    MIN_CONFIDENCE_FOR_INTENTS: 0.6,

    // Intenções que SEMPRE usam fallback (respostas críticas)
    FORCE_INTENTS_FOR: [
        'price_evaluation',
        'health_plans',
        'address',
        'session_duration'
    ],

    // Intenções que SEMPRE usam IA (casos complexos)
    FORCE_AI_FOR: [
        'complex_cases',
        'detailed_explanations'
    ],

    // Timeout para respostas de IA (ms)
    AI_TIMEOUT: 10000
};

export default {
    getOptimizedAmandaResponse,
    getQuickAmandaResponse,
    ORCHESTRATOR_CONFIG
};