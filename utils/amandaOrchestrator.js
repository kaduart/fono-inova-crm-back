// /src/utils/amandaOrchestrator.js - VERSÃO CORRIGIDA

import { getAmandaResponse } from './amandaIntents.js';
import { deriveFlagsFromText } from './amandaPrompt.js';
import { detectAllTherapies, generateEquivalenceResponse, generateMultiTherapyResponse, generateSingleTherapyResponse, isAskingAboutEquivalence } from './therapyDetector.js';

/**
 * Orquestrador principal - PRIORIZA NOSSA ESTRATÉGIA VALOR→PREÇO→ENGAJAMENTO
 */
export async function getOptimizedAmandaResponse(userMessage, context = {}) {
    const normalized = userMessage || "";
    const { useAIFallback = true, forceAI = false, forceIntents = false } = context;

    console.log(`🎯 [ORCHESTRATOR] Processando: "${normalized}"`);

    // 🚨 PRIORIDADE 1: Nossa estratégia de terapia específica
    const therapies = detectAllTherapies(normalized);
    const flags = deriveFlagsFromText(normalized);

    console.log(`🎯 [ORCHESTRATOR] Terapias detectadas: ${therapies.length}, Flags:`, flags);

    // ✅ SE DETECTOU TERAPIAS ESPECÍFICAS → USA NOSSA ESTRATÉGIA
    if (therapies.length > 0 && !forceIntents) {
        console.log(`🎯 [ORCHESTRATOR] Usando estratégia VALOR→PREÇO→ENGAJAMENTO`);

        if (therapies.length === 1) {
            const response = generateSingleTherapyResponse(therapies[0], normalized, flags);
            console.log(`🎯 [ORCHESTRATOR] Resposta específica: ${response}`);
            return response;
        } else {
            const response = generateMultiTherapyResponse(therapies, normalized, flags);
            console.log(`🎯 [ORCHESTRATOR] Resposta múltipla: ${response}`);
            return response;
        }
    }

    // ✅ SE PERGUNTA SOBRE EQUIVALÊNCIA
    if (isAskingAboutEquivalence(normalized) && !forceIntents) {
        const response = generateEquivalenceResponse(normalized);
        console.log(`🎯 [ORCHESTRATOR] Resposta equivalência: ${response}`);
        return response;
    }

    // 🎯 FALLBACK: Sistema de intenções (só se não detectou terapia específica)
    if (forceIntents) {
        const intentResponse = getAmandaResponse(normalized, true);
        return intentResponse?.message || "Desculpe, tive um problema. Pode repetir? 💚";
    }

    const intentResult = getAmandaResponse(normalized, useAIFallback);
    if (intentResult?.confidence >= 0.3 && !forceAI) {
        console.log(`🎯 [ORCHESTRATOR] Fallback para intenções: ${intentResult.intent}`);
        return intentResult.message;
    }

    // 🎯 ÚLTIMO RECURSO: IA principal
    try {
        const aiText = await callAIService({
            userText: normalized,
            context: { ...context, flags, therapies }
        });
        return aiText;
    } catch (err) {
        console.error(`❌ [ORCHESTRATOR] Erro IA:`, err);
        const fallback = getAmandaResponse(normalized, false);
        return fallback?.message || "Estou com dificuldades técnicas. Pode reformular sua pergunta? 💚";
    }
}

export default getOptimizedAmandaResponse;