export async function decisionEngine({ analysis, missing, urgency, bookingContext, clinicalRules }) {

    // =========================
    // 0️⃣ REGRA CLÍNICA BLOQUEIA
    // =========================
    if (clinicalRules?.blocked) {
        return {
            action: 'clinical_gate',
            handler: 'therapyGateHandler',
            reason: clinicalRules.reason || 'clinical_block'
        };
    }

    // =========================
    // 1️⃣ AGENDAMENTO
    // =========================
    if (analysis.intent === 'scheduling') {

        const missingKeys = Object.keys(missing).filter(k => missing[k]);

        if (missingKeys.length > 0) {
            return {
                action: 'ask_missing',
                handler: 'leadQualificationHandler',
                reason: missingKeys[0]
            };
        }

        if (bookingContext?.chosenSlot) {
            return {
                action: 'confirm_booking',
                handler: 'bookingHandler',
                reason: 'slot_chosen'
            };
        }

        return {
            action: 'booking',
            handler: 'bookingHandler',
            reason: 'ready_to_book'
        };
    }

    // =========================
    // 2️⃣ PREÇO
    // =========================
    if (analysis.intent === 'price') {
        return {
            action: 'price',
            handler: 'productHandler',
            reason: urgency >= 2 ? 'high_urgency_price' : 'normal_price'
        };
    }

    // =========================
    // 3️⃣ INFORMAÇÃO DE TERAPIA
    // =========================
    if (analysis.intent === 'therapy_info') {
        return {
            action: 'therapy_info',
            handler: 'therapyHandler',
            reason: 'therapy_explanation'
        };
    }

    // =========================
    // 4️⃣ PARCERIA
    // =========================
    if (analysis.intent === 'partnership') {
        return { handler: 'fallbackHandler', reason: 'partnership_fallback' };
    }
    // =========================
    // 5️⃣ EMPREGO
    // =========================
    if (analysis.intent === 'job') {
        return {
            action: 'job',
            handler: 'jobHandler',
            reason: 'job_request'
        };
    }

    // =========================
    // 6️⃣ QUALIFICAÇÃO PADRÃO
    // =========================
    return {
        action: 'qualification',
        handler: 'leadQualificationHandler',
        reason: 'default_qualification'
    };
}
