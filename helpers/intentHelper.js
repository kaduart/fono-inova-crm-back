/**
 * Normaliza intents do detector e LLM para taxonomia canônica
 * Resolve bug: product_inquiry vs price
 */

export const INTENT_TYPES = {
    PRICE: 'price',
    SCHEDULING: 'scheduling',
    THERAPY_INFO: 'therapy_info',
    COMPLAINT: 'complaint_collection',
    QUALIFICATION: 'qualification',
    GENERAL_INFO: 'general_info'
};

export function normalizeIntent(intentResult, llmIntent = null) {
    const type = intentResult?.type || '';
    const flags = intentResult?.flags || {};

    // Flags específicas têm prioridade
    if (flags.asksPrice || type === 'product_inquiry') return INTENT_TYPES.PRICE;
    if (flags.asksLocation || flags.asksHours) return INTENT_TYPES.GENERAL_INFO;

    // Mapeamento por type
    if (type === 'booking' || type === 'booking_ready') return INTENT_TYPES.SCHEDULING;
    if (type === 'therapy_question') return INTENT_TYPES.THERAPY_INFO;
    if (type === 'complaint') return INTENT_TYPES.COMPLAINT;

    // Fallback para LLM
    if (llmIntent?.primary) {
        const primary = llmIntent.primary.toLowerCase();
        if (primary.includes('preco') || primary.includes('valor')) return INTENT_TYPES.PRICE;
        if (primary.startsWith('agendar')) return INTENT_TYPES.SCHEDULING;
        if (primary.includes('terapia') || primary.includes('especialidade')) return INTENT_TYPES.THERAPY_INFO;
    }

    return type || INTENT_TYPES.QUALIFICATION;
}

export function isSideIntent(intent) {
    return [
        INTENT_TYPES.PRICE,
        INTENT_TYPES.THERAPY_INFO,
        INTENT_TYPES.GENERAL_INFO
    ].includes(intent);
}

export function isSchedulingIntent(intent) {
    return intent === INTENT_TYPES.SCHEDULING || intent === INTENT_TYPES.COMPLAINT;
}