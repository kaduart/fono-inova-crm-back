/**
 * 📊 DECISION TRACKING
 * 
 * Tracking de métricas do DecisionEngine para medir eficácia
 * das implementações F1-F7 e gaps P0
 */

// Métricas em memória (em produção, usar MongoDB/Redis)
const metrics = {
    decisions: {},
    gaps: {
        f1_contextualMemory: { hits: 0, skips: 0 },
        f2_valueBeforePrice: { used: 0, conversions: 0 },
        f3_insuranceBridge: { used: 0, clarifications: 0 },
        f4_seamlessHandover: { used: 0, bookings: 0 },
        f5_smartRepetition: { skips: 0, extracted: 0 },
        f6_emotionalSupport: { used: 0 },
        f7_urgencyPrioritization: { used: 0 },
        warmLeadDetection: { detected: 0, scheduled: 0 }
    },
    funnels: {
        complaint: { asked: 0, answered: 0 },
        therapy: { asked: 0, answered: 0 },
        age: { asked: 0, answered: 0 },
        period: { asked: 0, answered: 0 },
        slot: { offered: 0, accepted: 0 }
    }
};

/**
 * Registra uma decisão do DecisionEngine
 */
export function trackDecision(leadId, decisionType, data = {}) {
    const timestamp = new Date();
    
    if (!metrics.decisions[leadId]) {
        metrics.decisions[leadId] = [];
    }
    
    metrics.decisions[leadId].push({
        type: decisionType,
        timestamp,
        ...data
    });
    
    // Atualizar métricas específicas por gap
    updateGapMetrics(decisionType, data);
    
    console.log(`[TRACKING] ${decisionType}`, { leadId: leadId?.substring(0, 8), ...data });
}

/**
 * Atualiza métricas específicas de cada gap
 */
function updateGapMetrics(decisionType, data) {
    switch (decisionType) {
        case 'F1_VARIATION_USED':
            metrics.gaps.f1_contextualMemory.hits++;
            break;
        case 'F5_SKIP_QUESTION':
            metrics.gaps.f5_smartRepetition.skips++;
            metrics.gaps.f5_smartRepetition.extracted += data.extracted ? 1 : 0;
            break;
        case 'F4_SEAMLESS_HANDOVER':
            metrics.gaps.f4_seamlessHandover.used++;
            break;
        case 'DEVELOPMENTAL_URGENCY_RESULT':
            metrics.gaps.f7_urgencyPrioritization.used++;
            break;
        case 'PRIORITY_P2_SMART_RESPONSE':
            if (data.questionType === 'price') {
                metrics.gaps.f2_valueBeforePrice.used++;
            } else if (data.questionType === 'plans') {
                metrics.gaps.f3_insuranceBridge.used++;
            }
            break;
        case 'PRIORITY_P2_5_WARM_LEAD':
            metrics.gaps.warmLeadDetection.detected++;
            break;
        case 'WARM_LEAD_FOLLOWUP_SCHEDULED':
            metrics.gaps.warmLeadDetection.scheduled++;
            break;
    }
}

/**
 * Registra progresso no funil de qualificação
 */
export function trackFunnelStep(step, action, leadId) {
    if (!metrics.funnels[step]) return;
    
    metrics.funnels[step][action]++;
    
    console.log(`[FUNNEL] ${step}:${action}`, { leadId: leadId?.substring(0, 8) });
}

/**
 * Retorna relatório de métricas
 */
export function getMetricsReport() {
    return {
        timestamp: new Date(),
        gaps: metrics.gaps,
        funnels: metrics.funnels,
        conversionRates: {
            complaint: calculateRate(metrics.funnels.complaint),
            therapy: calculateRate(metrics.funnels.therapy),
            age: calculateRate(metrics.funnels.age),
            period: calculateRate(metrics.funnels.period),
            slot: calculateRate(metrics.funnels.slot, 'offered', 'accepted')
        },
        totalLeads: Object.keys(metrics.decisions).length
    };
}

function calculateRate(funnel, askedKey = 'asked', answeredKey = 'answered') {
    const asked = funnel[askedKey] || 0;
    const answered = funnel[answeredKey] || 0;
    return asked > 0 ? ((answered / asked) * 100).toFixed(2) + '%' : '0%';
}

/**
 * Limpa métricas (usar em testes)
 */
export function resetMetrics() {
    Object.keys(metrics.decisions).forEach(key => delete metrics.decisions[key]);
    Object.keys(metrics.gaps).forEach(key => {
        Object.keys(metrics.gaps[key]).forEach(subkey => {
            metrics.gaps[key][subkey] = 0;
        });
    });
    Object.keys(metrics.funnels).forEach(key => {
        metrics.funnels[key].asked = 0;
        metrics.funnels[key].answered = 0;
    });
}

/**
 * Exporta métricas para análise externa
 */
export function exportMetrics() {
    return JSON.stringify(metrics, null, 2);
}

export default {
    trackDecision,
    trackFunnelStep,
    getMetricsReport,
    resetMetrics,
    exportMetrics
};
