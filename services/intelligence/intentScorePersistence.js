/**
 * 🧠 INTENT SCORE PERSISTENCE (Amanda 4.2)
 * =======================================
 * 
 * Score acumulativo com decay leve.
 * Intenção não "evapora" entre mensagens.
 * 
 * Fórmula: newScore = (previousScore * 0.7) + currentSignals
 */

import { trackDecision } from '../analytics/decisionTracking.js';

// Decay factor - quanto do score anterior mantemos (70%)
const DECAY_FACTOR = 0.7;

// Mínimo de score para considerar (evita score muito baixo eterno)
const MIN_SCORE = 10;

// Máximo de histórico de scores a manter
const MAX_HISTORY = 10;

/**
 * 📊 Calcula score acumulativo com decay
 * @param {Object} params
 * @param {number} params.previousScore - Score anterior do lead
 * @param {number} params.currentSignals - Sinais da mensagem atual (0-100)
 * @param {Date} params.lastInteraction - Timestamp da última interação
 * @returns {Object} Novo score e metadata
 */
export function calculateAccumulativeScore({
    previousScore = 0,
    currentSignals = 0,
    lastInteraction = null,
    leadId = null
}) {
    // Se passou muito tempo (>24h), decay maior
    const hoursSinceLastInteraction = lastInteraction 
        ? (Date.now() - new Date(lastInteraction).getTime()) / (1000 * 60 * 60)
        : 0;
    
    // Ajusta decay baseado no tempo: mais tempo = mais decay
    let adjustedDecay = DECAY_FACTOR;
    if (hoursSinceLastInteraction > 24) {
        adjustedDecay = 0.5; // 50% após 24h
    } else if (hoursSinceLastInteraction > 4) {
        adjustedDecay = 0.6; // 60% após 4h
    }
    
    // Calcula novo score: decay do anterior + sinais atuais
    const decayedPrevious = previousScore * adjustedDecay;
    let newScore = decayedPrevious + currentSignals;
    
    // Garante limites
    newScore = Math.max(MIN_SCORE, Math.min(100, newScore));
    
    // Determina se subiu, desceu ou manteve
    const trend = newScore > previousScore ? 'up' : 
                  newScore < previousScore ? 'down' : 'stable';
    
    const result = {
        score: Math.round(newScore),
        previousScore: Math.round(previousScore),
        decayedPrevious: Math.round(decayedPrevious),
        currentSignals,
        decayFactor: adjustedDecay,
        trend,
        hoursSinceLastInteraction: Math.round(hoursSinceLastInteraction),
        isHot: newScore >= 75,
        isWarm: newScore >= 40 && newScore < 75,
        isCold: newScore < 40
    };
    
    // Track para analytics
    if (leadId) {
        trackDecision(leadId, 'INTENT_SCORE_ACCUMULATIVE', {
            score: result.score,
            previousScore: result.previousScore,
            trend,
            decayFactor: adjustedDecay
        });
    }
    
    return result;
}

/**
 * 📝 Atualiza histórico de scores do lead
 * @param {Array} history - Histórico atual
 * @param {Object} newEntry - Nova entrada
 * @returns {Array} Histórico atualizado (máx 10)
 */
export function updateIntentHistory(history = [], newEntry) {
    const updated = [...history, {
        ...newEntry,
        timestamp: new Date()
    }];
    
    // Mantém apenas os últimos MAX_HISTORY
    return updated.slice(-MAX_HISTORY);
}

/**
 * 📈 Analisa tendência do lead ao longo do tempo
 * @param {Array} history - Histórico de scores
 * @returns {Object} Análise de tendência
 */
export function analyzeIntentTrend(history = []) {
    if (history.length < 2) {
        return { trend: 'insufficient_data', direction: null };
    }
    
    const scores = history.map(h => h.score);
    const first = scores[0];
    const last = scores[scores.length - 1];
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    
    // Calcula direção geral
    const direction = last > first ? 'heating_up' : 
                      last < first ? 'cooling_down' : 'stable';
    
    // Detecta oscilação (volatilidade)
    const variations = [];
    for (let i = 1; i < scores.length; i++) {
        variations.push(Math.abs(scores[i] - scores[i-1]));
    }
    const avgVariation = variations.reduce((a, b) => a + b, 0) / variations.length;
    const isVolatile = avgVariation > 20;
    
    // Detecta padrão de interesse crescente
    const isProgressive = scores.every((score, i) => 
        i === 0 || score >= scores[i-1] * 0.9 // Permite pequena queda
    );
    
    return {
        trend: direction,
        direction,
        isVolatile,
        isProgressive,
        averageScore: Math.round(avg),
        peakScore: Math.max(...scores),
        currentVsFirst: last - first,
        messageCount: history.length
    };
}

/**
 * 🎯 Determina modo de conversação baseado no score acumulativo
 * @param {number} score - Score atual
 * @param {string} trend - Tendência (up/down/stable)
 * @returns {string} Modo: 'closing' | 'warming' | 'discovery'
 */
export function determineConversationMode(score, trend = 'stable') {
    // Modo fechamento: score alto OU subindo rápido para alto
    if (score >= 75 || (score >= 60 && trend === 'up')) {
        return 'closing';
    }
    
    // Modo aquecimento: score médio ou subindo
    if (score >= 40 || trend === 'up') {
        return 'warming';
    }
    
    // Modo descoberta: score baixo
    return 'discovery';
}

/**
 * 💾 Prepara dados para persistir no lead
 * @param {Object} lead - Lead atual
 * @param {Object} scoreResult - Resultado do cálculo
 * @returns {Object} Dados para salvar
 */
export function prepareIntentScoreForSave(lead, scoreResult) {
    const currentHistory = lead?.qualificationData?.intentHistory || [];
    const updatedHistory = updateIntentHistory(currentHistory, {
        score: scoreResult.score,
        trend: scoreResult.trend,
        signals: scoreResult.currentSignals
    });
    
    const trendAnalysis = analyzeIntentTrend(updatedHistory);
    
    return {
        'qualificationData.intentScore': scoreResult.score,
        'qualificationData.intentHistory': updatedHistory,
        'qualificationData.intentTrend': trendAnalysis.trend,
        'qualificationData.conversationMode': determineConversationMode(
            scoreResult.score, 
            scoreResult.trend
        ),
        'qualificationData.lastIntentUpdate': new Date()
    };
}

export default {
    calculateAccumulativeScore,
    updateIntentHistory,
    analyzeIntentTrend,
    determineConversationMode,
    prepareIntentScoreForSave,
    DECAY_FACTOR
};
