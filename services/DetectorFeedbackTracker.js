// services/DetectorFeedbackTracker.js
// 🎯 FASE 4: Service para rastrear detecções e resultados
// ✅ INTEGRA com infraestrutura existente (amandaLearningService)

import DetectorFeedback from '../models/DetectorFeedback.js';
import Leads from '../models/Leads.js';

// ✅ REUTILIZA funções existentes do amandaLearningService
import {
    cleanText,
    isValidText,
    calculateConversionTime
} from './amandaLearningService.js';

/**
 * 📝 Registra uma detecção do detector contextual
 *
 * Chamado logo após detectWithContextualDetectors() no Orchestrator
 *
 * @param {Object} params - Parâmetros da detecção
 * @returns {String|null} - ID do feedback criado ou null se erro
 */
export async function trackDetection({
    detector,           // 'price', 'scheduling', 'confirmation', 'insurance'
    pattern,            // 'objection', 'urgency', 'insistence', etc
    text,              // Texto da mensagem original
    confidence,        // Confiança da detecção (0-1)
    lead,              // Objeto lead
    messageId,         // ID da mensagem (opcional)
    strategicHint      // Hint aplicado (FASE 3)
}) {
    try {
        // ✅ REUTILIZA: Limpa texto usando função existente
        const cleanedText = cleanText(text);

        // ✅ REUTILIZA: Valida texto usando função existente
        if (!isValidText(cleanedText)) {
            console.log(`⚠️ [DETECTOR-FEEDBACK] Texto inválido, não rastreando`);
            return null;
        }

        // Extrai strategic hint usado (se disponível)
        const hint = strategicHint ? {
            tone: strategicHint.tone,
            approach: strategicHint.approach,
            priority: strategicHint.priority
        } : {};

        // Salva tracking
        const feedback = await DetectorFeedback.create({
            detector,
            pattern,
            text: cleanedText,
            confidence,
            lead: lead._id,
            message: messageId,
            therapyArea: lead.therapyArea,
            stage: lead.stage,
            strategicHint: hint
        });

        console.log(`📝 [DETECTOR-FEEDBACK] Tracked ${detector}:${pattern} (confidence: ${confidence.toFixed(2)})`);

        return feedback._id.toString();
    } catch (err) {
        console.error('[DETECTOR-FEEDBACK] Error tracking:', err.message);
        return null;
    }
}

/**
 * 📊 Registra o resultado de uma detecção
 *
 * Chamado quando:
 * - Lead agenda (conversão = true)
 * - Lead responde negativamente
 * - Timeout sem resposta
 *
 * @param {Object} params - Parâmetros do outcome
 * @returns {Object} - Resultado da operação
 */
export async function recordOutcome({
    leadId,
    converted = false,
    specificMetrics = {}
}) {
    try {
        // Busca todas as detecções deste lead que ainda não têm outcome
        const pendingFeedbacks = await DetectorFeedback.findPendingByLead(leadId);

        if (pendingFeedbacks.length === 0) {
            console.log(`ℹ️ [DETECTOR-FEEDBACK] No pending feedbacks for lead ${leadId}`);
            return { updated: 0 };
        }

        // Busca lead para calcular tempo de conversão
        const lead = await Leads.findById(leadId).lean();
        if (!lead) {
            console.warn(`⚠️ [DETECTOR-FEEDBACK] Lead ${leadId} not found`);
            return { updated: 0 };
        }

        // ✅ REUTILIZA: Calcula tempo de conversão usando função existente
        const timeToConversion = calculateConversionTime(lead);

        // Atualiza todos os feedbacks pendentes
        const updates = await Promise.all(
            pendingFeedbacks.map(async (feedback) => {
                // Valida se contexto estava correto
                const contextCorrect = await validateContext(feedback, lead);

                feedback.outcome = {
                    recorded: true,
                    converted,
                    timeToConversion,
                    contextCorrect,
                    detectionUseful: converted, // Simplificado: se converteu, foi útil
                    specificMetrics,
                    recordedAt: new Date()
                };

                return feedback.save();
            })
        );

        console.log(`📊 [DETECTOR-FEEDBACK] Recorded outcome for ${updates.length} detections (converted: ${converted})`);

        return {
            updated: updates.length,
            converted,
            timeToConversion
        };
    } catch (err) {
        console.error('[DETECTOR-FEEDBACK] Error recording outcome:', err.message);
        return { updated: 0, error: err.message };
    }
}

/**
 * ✅ Valida se o contexto da detecção estava correto
 *
 * Verifica se a detecção foi precisa baseado no comportamento subsequente
 */
async function validateContext(feedback, lead) {
    // Validação específica por detector
    switch (feedback.detector) {
        case 'price':
            // Se detectou objeção de preço, verifica se lead realmente tinha objeção
            if (feedback.pattern === 'objection') {
                // Se converteu rapidamente, talvez não fosse objeção real
                return feedback.outcome?.timeToConversion > 30; // >30min = objeção real
            }
            // Para outros padrões, assume correto se confidence > 0.8
            return feedback.confidence > 0.8;

        case 'scheduling':
            // Se detectou urgência, verifica se lead realmente agendou rápido
            if (feedback.pattern === 'urgency') {
                return feedback.outcome?.timeToConversion < 60; // <60min = urgência real
            }
            return feedback.confidence > 0.8;

        case 'confirmation':
        case 'insurance':
            // Para estes, assume correto se confidence > 0.8
            return feedback.confidence > 0.8;

        default:
            return feedback.confidence > 0.7;
    }
}

/**
 * 📈 Calcula efetividade de um detector específico
 *
 * Retorna métricas agregadas de performance
 */
export async function calculateDetectorEffectiveness(detector, pattern = null, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const query = {
        detector,
        'outcome.recorded': true,
        createdAt: { $gte: since }
    };

    if (pattern) {
        query.pattern = pattern;
    }

    const feedbacks = await DetectorFeedback.find(query);

    if (feedbacks.length === 0) {
        return {
            detector,
            pattern,
            totalDetections: 0,
            noData: true
        };
    }

    const converted = feedbacks.filter(f => f.outcome.converted);
    const contextCorrect = feedbacks.filter(f => f.outcome.contextCorrect);

    const avgConfidence = feedbacks.reduce((sum, f) => sum + f.confidence, 0) / feedbacks.length;

    const avgTimeToConversion = converted.length > 0
        ? converted.reduce((sum, f) => sum + (f.outcome.timeToConversion || 0), 0) / converted.length
        : 0;

    return {
        detector,
        pattern,
        totalDetections: feedbacks.length,
        conversions: converted.length,
        conversionRate: Math.round((converted.length / feedbacks.length) * 100 * 10) / 10,
        avgConfidence: Math.round(avgConfidence * 100) / 100,
        avgTimeToConversion: Math.round(avgTimeToConversion),

        // Precisão
        contextCorrect: contextCorrect.length,
        precision: Math.round((contextCorrect.length / feedbacks.length) * 100 * 10) / 10,

        // Detalhes
        truePositives: converted.filter(f => f.outcome.contextCorrect).length,
        falsePositives: feedbacks.filter(f => !f.outcome.converted && !f.outcome.contextCorrect).length
    };
}

/**
 * 📊 Exporta estatísticas gerais dos detectores
 */
export async function getDetectorStats(days = 30) {
    const detectors = ['price', 'scheduling', 'confirmation', 'insurance'];
    const stats = {};

    for (const detector of detectors) {
        stats[detector] = await calculateDetectorEffectiveness(detector, null, days);
    }

    return {
        period: `${days} days`,
        generatedAt: new Date(),
        detectors: stats
    };
}

/**
 * 🔍 Busca feedbacks de baixa confiança que converteram
 * (potenciais novos padrões)
 */
export async function findLowConfidenceConversions(detector, days = 30, maxConfidence = 0.7) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    return DetectorFeedback.find({
        detector,
        confidence: { $lt: maxConfidence },
        'outcome.recorded': true,
        'outcome.converted': true,
        createdAt: { $gte: since }
    })
    .limit(50)
    .sort({ createdAt: -1 });
}

export default {
    trackDetection,
    recordOutcome,
    calculateDetectorEffectiveness,
    getDetectorStats,
    findLowConfidenceConversions
};
