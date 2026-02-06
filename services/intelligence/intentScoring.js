/**
 * 🎯 INTENT SCORING ENGINE
 * 
 * Calcula score de intenção de agendamento (0-100)
 * Quando score > 70: Amanda vira closer automático
 */

import { trackDecision } from '../analytics/decisionTracking.js';

// Pesos para cada sinal de intenção
const SCORE_WEIGHTS = {
    PRICING_INQUIRY: 15,        // Perguntou preço
    SCHEDULE_INQUIRY: 25,       // Perguntou horários
    BOOKING_INTENT: 50,         // Falou "quero marcar"
    FAST_RESPONSE: 10,          // Respondeu em < 5 min
    RETURNED_AFTER_24H: 20,     // Voltou após 24h+
    COMPLETE_DATA: 30,          // Preencheu todos os dados
    EXPRESSED_URGENCY: 15,      // Urgência explícita
    MULTIPLE_CHILDREN: 10,      // Múltiplas crianças (maior engajamento)
    EMOTIONAL_INVESTMENT: 10,   // Descreveu detalhadamente
    POSITIVE_SENTIMENT: 10,     // Sentimento positivo detectado
    NEGATIVE_SIGNAL: -20,       // Cancelou ou desistiu
    GHOSTED_BEFORE: -15         // Sumiu antes
};

/**
 * 🧮 Calcula score de intenção de agendamento
 * @param {Object} params - Parâmetros para cálculo
 * @returns {Object} Score + análise + recomendação de ação
 */
export function calculateIntentScore({
    leadId,
    message,
    flags = {},
    memory = {},
    chatContext = {},
    analysis = {},
    lastInteraction = null,
    messageCount = 0
}) {
    let score = 0;
    const signals = [];
    const negativeSignals = [];

    // 1️⃣ SINAIS POSITIVOS DE INTENÇÃO
    
    // Perguntou preço (+15)
    if (flags.asksPrice || flags.asksAboutPrice) {
        score += SCORE_WEIGHTS.PRICING_INQUIRY;
        signals.push('pricing_inquiry');
    }
    
    // Perguntou horários (+25)
    if (flags.asksSchedule || flags.wantsSchedule) {
        score += SCORE_WEIGHTS.SCHEDULE_INQUIRY;
        signals.push('schedule_inquiry');
    }
    
    // Intenção explícita de agendar (+50)
    if (detectBookingIntent(message)) {
        score += SCORE_WEIGHTS.BOOKING_INTENT;
        signals.push('explicit_booking');
    }
    
    // Resposta rápida (+10)
    if (lastInteraction && isFastResponse(lastInteraction)) {
        score += SCORE_WEIGHTS.FAST_RESPONSE;
        signals.push('fast_response');
    }
    
    // Voltou após 24h+ (+20)
    if (memory?.daysSinceLastContact > 1) {
        score += SCORE_WEIGHTS.RETURNED_AFTER_24H;
        signals.push('returned_after_24h');
    }
    
    // Dados completos (+30)
    if (hasCompleteData(memory)) {
        score += SCORE_WEIGHTS.COMPLETE_DATA;
        signals.push('complete_data');
    }
    
    // Urgência (+15)
    if (flags.expressedUrgency || memory?.emotionalContext?.expressedUrgency) {
        score += SCORE_WEIGHTS.EXPRESSED_URGENCY;
        signals.push('expressed_urgency');
    }
    
    // Múltiplas crianças (+10)
    if (flags.hasMultipleChildren || memory?.emotionalContext?.multipleChildren) {
        score += SCORE_WEIGHTS.MULTIPLE_CHILDREN;
        signals.push('multiple_children');
    }
    
    // Investimento emocional (+10)
    if (isEmotionallyInvested(message)) {
        score += SCORE_WEIGHTS.EMOTIONAL_INVESTMENT;
        signals.push('emotional_investment');
    }
    
    // Sentimento positivo (+10)
    if (analysis?.sentiment === 'positive' || analysis?.intent?.sentiment === 'positive') {
        score += SCORE_WEIGHTS.POSITIVE_SENTIMENT;
        signals.push('positive_sentiment');
    }
    
    // 2️⃣ SINAIS NEGATIVOS
    
    // Cancelou antes (-20)
    if (flags.isCancellation || memory?.emotionalContext?.cancellation) {
        score += SCORE_WEIGHTS.NEGATIVE_SIGNAL;
        negativeSignals.push('cancellation');
    }
    
    // Sumiu antes (-15)
    if (memory?.hasGhostedBefore) {
        score += SCORE_WEIGHTS.GHOSTED_BEFORE;
        negativeSignals.push('ghosted_before');
    }
    
    // 3️⃣ LIMITAR SCORE
    score = Math.max(0, Math.min(100, score));
    
    // 4️⃣ DETERMINAR AÇÃO RECOMENDADA
    const action = determineActionByScore(score, signals);
    
    // 5️⃣ LOG PARA ANALYTICS
    if (leadId) {
        trackDecision(leadId, 'INTENT_SCORE_CALCULATED', {
            score,
            signals,
            negativeSignals,
            action: action.type,
            hasCompleteData: hasCompleteData(memory)
        });
    }
    
    return {
        score,
        signals,
        negativeSignals,
        action,
        isHotLead: score >= 70,
        isWarmLead: score >= 40 && score < 70,
        isColdLead: score < 40
    };
}

/**
 * 🔥 Detecta intenção explícita de agendar
 */
function detectBookingIntent(message) {
    if (!message) return false;
    
    const bookingPatterns = [
        /\b(quero\s+agendar|vamos\s+agendar|pode\s+agendar|quero\s+marcar|vamos\s+marcar)\b/i,
        /\b(tem\s+vaga|tem\s+hor[áa]rio|quando\s+(tem|posso))\b/i,
        /\b(pode\s+ver|pode\s+conferir)\s+(vaga|hor[áa]rio)\b/i,
        /\b(show|bora|vamos\s+nessa|fechado|confirmado)\b/i,
        /\b(quero\s+come[çc]ar|quero\s+iniciar)\b/i
    ];
    
    const text = message.toLowerCase();
    return bookingPatterns.some(pattern => pattern.test(text));
}

/**
 * ⚡ Verifica se respondeu em menos de 5 minutos
 */
function isFastResponse(lastInteraction) {
    if (!lastInteraction) return false;
    const diff = Date.now() - new Date(lastInteraction).getTime();
    return diff < 5 * 60 * 1000; // 5 minutos
}

/**
 * 📋 Verifica se tem dados completos para agendar
 */
function hasCompleteData(memory) {
    const hasTherapy = !!memory?.therapyArea;
    const hasAge = !!(memory?.patientAge || memory?.patientInfo?.age);
    const hasComplaint = !!(memory?.complaint || memory?.primaryComplaint);
    
    return hasTherapy && hasAge && hasComplaint;
}

/**
 * 💝 Verifica se descreveu detalhadamente (investimento emocional)
 */
function isEmotionallyInvested(message) {
    if (!message) return false;
    
    // Mensagem longa com detalhes pessoais
    const wordCount = message.split(/\s+/).length;
    const hasDetails = /\b(filho|filha|meu|minha|ele|ela|n[ãa]o consegue|dificuldade|preocupada)\b/i.test(message);
    
    return wordCount > 15 && hasDetails;
}

/**
 * 🎯 Determina ação recomendada baseada no score
 */
function determineActionByScore(score, signals) {
    // SCORE >= 70: CLOSER MODE
    if (score >= 70) {
        return {
            type: 'CLOSER_MODE',
            tone: 'assertive_confident',
            strategy: 'offer_specific_slot',
            message: 'Lead quente! Oferecer horário específico e fechar',
            cta: 'Posso garantir um horário [dia] às [hora] para você? 💚',
            avoid: ['long_explanations', 'asking_too_many_questions']
        };
    }
    
    // SCORE 40-69: CONSULTORIA MODE
    if (score >= 40) {
        return {
            type: 'CONSULTORIA_MODE',
            tone: 'helpful_guiding',
            strategy: 'build_value_then_offer',
            message: 'Lead interessado. Construir valor e oferecer agendamento suave',
            cta: 'Quer que eu verifique a disponibilidade para essa semana?',
            avoid: ['pushing_too_hard']
        };
    }
    
    // SCORE < 40: ACOLHIMENTO MODE
    return {
        type: 'ACOLHIMENTO_MODE',
        tone: 'warm_nurturing',
        strategy: 'educate_and_qualify',
        message: 'Lead frio. Acolher, educar, coletar dados',
        cta: 'Me conta um pouco sobre a situação? 💚',
        avoid: ['pushing_for_sale', 'talking_price_too_early']
    };
}

/**
 * 📊 Retorna estatísticas de scoring para dashboard
 */
export function getIntentScoreStats(scores = []) {
    if (scores.length === 0) return null;
    
    const total = scores.length;
    const hot = scores.filter(s => s >= 70).length;
    const warm = scores.filter(s => s >= 40 && s < 70).length;
    const cold = scores.filter(s => s < 40).length;
    const avg = scores.reduce((a, b) => a + b, 0) / total;
    
    return {
        total,
        hot,
        warm,
        cold,
        hotPercentage: ((hot / total) * 100).toFixed(1),
        warmPercentage: ((warm / total) * 100).toFixed(1),
        coldPercentage: ((cold / total) * 100).toFixed(1),
        averageScore: avg.toFixed(1)
    };
}

/**
 * 📊 Retorna nível do score (hot/warm/cold)
 */
export function getScoreLevel(score) {
    if (score >= 70) return 'hot';
    if (score >= 40) return 'warm';
    return 'cold';
}

/**
 * 🎯 Ações recomendadas por nível de score
 */
export const RECOMMENDED_ACTIONS = {
    hot: {
        tone: 'assertive_confident',
        strategy: 'offer_specific_slot',
        cta: 'Posso garantir um horário para você? 💚'
    },
    warm: {
        tone: 'helpful_guiding',
        strategy: 'build_value_then_offer',
        cta: 'Quer que eu verifique a disponibilidade?'
    },
    cold: {
        tone: 'warm_nurturing',
        strategy: 'educate_and_qualify',
        cta: 'Me conta um pouco sobre a situação? 💚'
    }
};

export default {
    calculateIntentScore,
    getIntentScoreStats,
    getScoreLevel,
    RECOMMENDED_ACTIONS,
    SCORE_WEIGHTS
};
