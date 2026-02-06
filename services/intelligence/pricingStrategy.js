/**
 * 💰 SMART PRICE PSYCHOLOGY (Amanda 4.2)
 * ======================================
 * 
 * Mostra pacote primeiro para leads quentes.
 * Aumenta ticket médio automaticamente.
 */

import { PRICES, formatPrice } from '../../config/pricing.js';

// Thresholds para estratégia de preço
const HOT_LEAD_THRESHOLD = 60;  // Mostra pacote primeiro
const WARM_LEAD_THRESHOLD = 40; // Mostra ambos, destaca economia

/**
 * 🎯 Determina estratégia de apresentação de preço
 * @param {number} intentScore - Score de intenção
 * @param {Object} flags - Flags detectadas
 * @returns {string} Estratégia: 'package_first' | 'balanced' | 'single_first'
 */
export function determinePricingStrategy(intentScore = 0, flags = {}) {
    // Lead quente: pacote primeiro (já quer, só precisa ver valor)
    if (intentScore >= HOT_LEAD_THRESHOLD || flags.wantsSchedule) {
        return 'package_first';
    }
    
    // Lead morno: mostra ambos com destaque na economia
    if (intentScore >= WARM_LEAD_THRESHOLD || flags.asksPrice) {
        return 'balanced';
    }
    
    // Lead frio: avulso primeiro (menor compromisso)
    return 'single_first';
}

/**
 * 💎 Gera texto de preço com estratégia definida
 * @param {string} therapyKey - Área terapêutica
 * @param {string} strategy - Estratégia a usar
 * @param {Object} options - Opções adicionais
 * @returns {Object} Texto e metadata
 */
export function buildStrategicPriceText(therapyKey = 'FONOAUDIOLOGIA', strategy, options = {}) {
    const avulso = PRICES.AVULSO[therapyKey];
    const pacote2x = PRICES.PACOTE_2X[therapyKey];
    const pacote4x = PRICES.PACOTE_4X[therapyKey];
    
    const economia2x = avulso - pacote2x;
    const economia4x = (avulso * 4) - (pacote4x * 4);
    
    const texts = {
        package_first: {
            headline: `💚 Investimento no pacote (melhor valor):`,
            body: [
                `• Pacote 4x: ${formatPrice(pacote4x)}/sessão → economia de ${formatPrice(economia4x)} no total`,
                `• Pacote 2x: ${formatPrice(pacote2x)}/sessão → economia de ${formatPrice(economia2x)}`,
                `• Avulso: ${formatPrice(avulso)}/sessão (avaliação individual)`,
                ``,
                `A maioria dos pais escolhe o pacote porque o acompanhamento contínuo traz resultados mais rápidos 💚`
            ].join('\n'),
            emphasis: 'package',
            cta: 'Quer que eu reserve um pacote para você?'
        },
        
        balanced: {
            headline: `💰 Investimento:`,
            body: [
                `• Avulso: ${formatPrice(avulso)} (avaliação individual)`,
                `• Pacote 2x: ${formatPrice(pacote2x)}/sessão 💚`,
                `• Pacote 4x: ${formatPrice(pacote4x)}/sessão (melhor custo-benefício) 💚💚`,
                ``,
                `O pacote 4x tem o melhor valor e é o mais escolhido pelos pais.`
            ].join('\n'),
            emphasis: 'both',
            cta: 'Qual opção faz mais sentido para vocês?'
        },
        
        single_first: {
            headline: `💰 Investimento:`,
            body: [
                `• Avulso: ${formatPrice(avulso)} (avaliação individual, sem compromisso)`,
                `• Pacote 2x: ${formatPrice(pacote2x)}/sessão`,
                `• Pacote 4x: ${formatPrice(pacote4x)}/sessão (economia no acompanhamento)`,
                ``,
                `Muitos pais começam com uma sessão avulsa e, vendo o resultado, migram para o pacote.`
            ].join('\n'),
            emphasis: 'single',
            cta: 'Quer começar com uma avaliação avulsa?'
        }
    };
    
    const selected = texts[strategy] || texts.balanced;
    
    return {
        ...selected,
        strategy,
        prices: { avulso, pacote2x, pacote4x },
        savings: { pacote2x: economia2x, pacote4x: economia4x }
    };
}

/**
 * 🎯 Versão curta para hot leads (mais objetiva)
 * @param {string} therapyKey - Área terapêutica
 * @returns {string} Texto curto e direto
 */
export function buildClosingPriceText(therapyKey = 'FONOAUDIOLOGIA') {
    const pacote4x = PRICES.PACOTE_4X[therapyKey];
    
    return `Pacote 4 sessões: ${formatPrice(pacote4x)}/sessão (melhor valor). Quer que eu reserve essa semana? 💚`;
}

/**
 * 💚 Versão com foco em valor (para antes de mostrar preço)
 * @param {Object} context - Contexto do lead
 * @returns {string} Texto de valor
 */
export function buildValueAnchorText(context = {}) {
    const { patientName, patientAge, primaryComplaint } = context;
    
    const nameRef = patientName || 'a criança';
    
    const valueTexts = [
        `O investimento vale cada centavo quando a gente vê ${nameRef} evoluindo.`,
        `Muitos pais dizem que demoraram para começar e se arrependem de não terem começado antes.`,
        `O resultado compensa o investimento. 💚`
    ];
    
    return valueTexts.join(' ');
}

/**
 * 🎭 Adapta tom baseado no perfil de preço
 * @param {number} intentScore - Score
 * @param {Object} memory - Memória
 * @returns {Object} Configuração de tom
 */
export function getPricingTone(intentScore, memory = {}) {
    const priceSensitivity = memory.memoryWindow?.find(m => m.type === 'price_sensitivity');
    const isSensitive = priceSensitivity?.value === 'high';
    
    // Lead quente mas sensível a preço: focar em valor e parcelamento
    if (intentScore >= HOT_LEAD_THRESHOLD && isSensitive) {
        return {
            tone: 'value_focused',
            mentionInstallments: true,
            emphasizeResults: true,
            offerDiscount: false,
            pace: 'patient'
        };
    }
    
    // Lead quente: assertivo
    if (intentScore >= HOT_LEAD_THRESHOLD) {
        return {
            tone: 'confident',
            mentionInstallments: false,
            emphasizeResults: true,
            offerDiscount: false,
            pace: 'direct'
        };
    }
    
    // Lead sensível a preço: educativo
    if (isSensitive) {
        return {
            tone: 'educational',
            mentionInstallments: true,
            emphasizeResults: false,
            offerDiscount: true,
            pace: 'patient'
        };
    }
    
    // Default
    return {
        tone: 'neutral',
        mentionInstallments: false,
        emphasizeResults: false,
        offerDiscount: false,
        pace: 'normal'
    };
}

/**
 * 🧮 Calcula economia para mostrar no texto
 * @param {string} therapyKey - Área
 * @param {number} sessions - Número de sessões
 * @returns {Object} Economia calculada
 */
export function calculateSavingsDisplay(therapyKey, sessions = 4) {
    const avulso = PRICES.AVULSO[therapyKey];
    const pacote = sessions === 2 ? PRICES.PACOTE_2X[therapyKey] : PRICES.PACOTE_4X[therapyKey];
    
    const avulsoTotal = avulso * sessions;
    const pacoteTotal = pacote * sessions;
    const economia = avulsoTotal - pacoteTotal;
    const percentual = Math.round((economia / avulsoTotal) * 100);
    
    return {
        avulsoTotal,
        pacoteTotal,
        economia,
        percentual,
        formatted: formatPrice(economia),
        perSession: formatPrice(pacote)
    };
}

export default {
    determinePricingStrategy,
    buildStrategicPriceText,
    buildClosingPriceText,
    buildValueAnchorText,
    getPricingTone,
    calculateSavingsDisplay,
    HOT_LEAD_THRESHOLD,
    WARM_LEAD_THRESHOLD
};
