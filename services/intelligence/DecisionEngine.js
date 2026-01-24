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
    // 1️⃣ AGENDAMENTO (COM ACOLHIMENTO OBRIGATÓRIO)
    // =========================
    if (analysis.intent === 'scheduling') {
        const missingKeys = Object.keys(missing).filter(k => missing[k]);

        // Se falta dados básicos (terapia, idade, período)
        if (missingKeys.length > 0) {
            // NÃO tratar 'needsComplaint', 'needsSlot' nem 'needsName' como "básico"
            // - needsComplaint = etapa do meio (queixa)
            // - needsSlot = tarefa do booking handler (buscar/mostrar slots)
            // - needsName = só depois que houver slot escolhido
            const basicDataMissing = missingKeys.filter(k =>
                !['needsComplaint', 'needsSlot', 'needsName'].includes(k)
            );

            if (basicDataMissing.length > 0) {
                return {
                    action: 'ask_missing',
                    handler: 'leadQualificationHandler',
                    reason: basicDataMissing[0]
                };
            }
        }

        // 🆕 ETAPA DO MEIO: Queixa antes de mostrar horários
        if (missing.needsComplaint) {
            return {
                action: 'collect_complaint',
                handler: 'complaintCollectionHandler',
                reason: 'needs_clinical_context_before_scheduling'
            };
        }

        // Se já escolheu slot → coleta dados do paciente (passo a passo) / confirma
        if (bookingContext?.chosenSlot) {
            if (missing.needsName) {
                return {
                    action: 'collect_patient_data',
                    handler: 'bookingHandler',
                    reason: 'needsName'
                };
            }

            return {
                action: 'confirm_booking',
                handler: 'bookingHandler',
                reason: 'slot_chosen'
            };
        }

        // Se tem tudo (dados + queixa) → mostra/busca slots
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
    // 6️⃣ QUEIXA (FORA DO SCHEDULING)
    // =========================
    if (!missing.needsTherapy && !missing.needsAge && !missing.needsPeriod && missing.needsComplaint) {
        return {
            action: 'collect_complaint',
            handler: 'complaintCollectionHandler',
            reason: 'awaiting_clinical_context'
        };
    }

    // =========================
    // 7️⃣ SLOT ESCOLHIDO, MAS INTENT NÃO ESTÁ "scheduling"
    // =========================
    if (bookingContext?.chosenSlot && missing.needsName) {
        return {
            action: 'collect_patient_data',
            handler: 'bookingHandler',
            reason: 'needsName'
        };
    }

    // =========================
    // 8️⃣ QUALIFICAÇÃO PADRÃO
    // =========================
    return {
        action: 'qualification',
        handler: 'leadQualificationHandler',
        reason: 'default_qualification'
    };
}
