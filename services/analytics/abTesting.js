/**
 * 🧪 A/B TESTING SYSTEM
 * 
 * Sistema simples de testes A/B para comparar comportamentos
 * da Amanda (versão antiga vs nova)
 */

import { createHash } from 'crypto';

// Configuração dos experimentos
const EXPERIMENTS = {
    // Experimento: Novo DecisionEngine vs Legado
    decisionEngine_v2: {
        enabled: true,
        trafficSplit: 0.10, // 10% dos leads no novo comportamento
        description: 'Testa o novo DecisionEngine com F1-F7'
    },
    
    // Experimento: Value-before-price
    value_before_price: {
        enabled: true,
        trafficSplit: 0.50, // 50% A/B test
        description: 'Testa explicar valor antes de dar preço'
    },
    
    // Experimento: Emotional support
    emotional_support: {
        enabled: true,
        trafficSplit: 0.30, // 30% dos leads
        description: 'Testa acolhimento emocional contextual'
    }
};

/**
 * Determina qual variante um lead deve usar
 * @param {string} leadId - ID do lead
 * @param {string} experimentName - Nome do experimento
 * @returns {string} - 'control' (original) ou 'treatment' (novo)
 */
export function getVariant(leadId, experimentName) {
    const experiment = EXPERIMENTS[experimentName];
    
    if (!experiment || !experiment.enabled) {
        return 'control'; // Se experimento desativado, usa controle
    }
    
    // Hash consistente baseado no leadId
    const hash = createHash('md5')
        .update(`${experimentName}:${leadId}`)
        .digest('hex');
    
    // Converte hash para número entre 0-1
    const hashNum = parseInt(hash.substring(0, 8), 16) / 0xFFFFFFFF;
    
    // Determina variante baseado no split
    return hashNum < experiment.trafficSplit ? 'treatment' : 'control';
}

/**
 * Verifica se deve usar novo comportamento
 * @param {string} leadId - ID do lead
 * @param {string} featureName - Nome da feature (experimento)
 * @returns {boolean}
 */
export function shouldUseNewBehavior(leadId, featureName = 'decisionEngine_v2') {
    return getVariant(leadId, featureName) === 'treatment';
}

/**
 * Registra resultado de um experimento
 * Em produção, isso iria para MongoDB/Analytics
 */
const experimentResults = {};

export function trackExperimentResult(experimentName, variant, result) {
    if (!experimentResults[experimentName]) {
        experimentResults[experimentName] = {
            control: { count: 0, conversions: 0, data: [] },
            treatment: { count: 0, conversions: 0, data: [] }
        };
    }
    
    experimentResults[experimentName][variant].count++;
    if (result.converted) {
        experimentResults[experimentName][variant].conversions++;
    }
    experimentResults[experimentName][variant].data.push({
        timestamp: new Date(),
        ...result
    });
}

/**
 * Retorna relatório de experimentos
 */
export function getExperimentReport() {
    const report = {};
    
    for (const [name, data] of Object.entries(experimentResults)) {
        const controlRate = data.control.count > 0 
            ? (data.control.conversions / data.control.count * 100).toFixed(2)
            : 0;
        const treatmentRate = data.treatment.count > 0
            ? (data.treatment.conversions / data.treatment.count * 100).toFixed(2)
            : 0;
            
        report[name] = {
            control: {
                count: data.control.count,
                conversions: data.control.conversions,
                rate: `${controlRate}%`
            },
            treatment: {
                count: data.treatment.count,
                conversions: data.treatment.conversions,
                rate: `${treatmentRate}%`
            },
            lift: treatmentRate > 0 && controlRate > 0
                ? `+${((treatmentRate - controlRate) / controlRate * 100).toFixed(1)}%`
                : 'N/A'
        };
    }
    
    return report;
}

/**
 * Atualiza configuração de um experimento
 */
export function updateExperimentConfig(experimentName, config) {
    if (EXPERIMENTS[experimentName]) {
        EXPERIMENTS[experimentName] = { ...EXPERIMENTS[experimentName], ...config };
        return true;
    }
    return false;
}

/**
 * Lista todos os experimentos ativos
 */
export function listExperiments() {
    return Object.entries(EXPERIMENTS).map(([name, config]) => ({
        name,
        ...config
    }));
}

export default {
    getVariant,
    shouldUseNewBehavior,
    trackExperimentResult,
    getExperimentReport,
    updateExperimentConfig,
    listExperiments
};
