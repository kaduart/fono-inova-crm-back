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
    // 🆕 REGRA 0: INTERRUPIÇÃO (Side Intent com agendamento pendente)
    // Se usuário perguntou preço/info mas tem slots pendentes, responde e preserva estado
    // =========================
    // 🆕 REGRA 0: INTERRUPIÇÃO (Side Intent com agendamento EM QUALQUER ESTÁGIO)
    const hasPendingSlots = bookingContext?.slots?.primary || bookingContext?.chosenSlot;

    // Protege se já temos dados de agendamento em andamento (não precisa ter slots ainda)
    // 🆕 REGRA 0: INTERRUPIÇÃO (Side Intent com agendamento em QUALQUER estágio)
    const isSideIntent = ['price', 'therapy_info', 'general_info'].includes(analysis.intent);

    // Usa lógica do helper: protege se já tem contexto de agendamento (não precisa ter slots ainda)
    const hasSchedulingContext =
        bookingContext?.slots?.primary ||
        bookingContext?.chosenSlot ||
        (!missing.needsTherapy && !missing.needsComplaint); // Já passou das etapas iniciais

    if (isSideIntent && hasSchedulingContext) {
        const handlerMap = {
            'price': 'productHandler',
            'therapy_info': 'therapyHandler',
            'general_info': 'fallbackHandler'
        };

        return {
            action: 'answer_and_preserve_state',
            handler: handlerMap[analysis.intent] || 'fallbackHandler',
            reason: 'interruption_while_qualifying',
            preserveBookingState: true,
            pendingField: missing.currentAwaiting // 🆕 AGORA SIM! Alimenta o Orchestrator
        };
    }

    // =========================
    // 1️⃣ AGENDAMENTO (ORDEM CORRETA: Terapia → Queixa → Idade → Período → Slots)
    // =========================
    if (analysis.intent === 'scheduling') {

        // 1️⃣ TERAPIA (primeiro - sem isso não prossegue)
        if (missing.needsTherapy) {
            return {
                action: 'ask_therapy',
                handler: 'leadQualificationHandler',
                reason: 'needsTherapy'
            };
        }

        // 2️⃣ QUEIXA (acolhimento clínico - vem ANTES de idade/período!)
        if (missing.needsComplaint) {
            return {
                action: 'collect_complaint',
                handler: 'complaintCollectionHandler',
                reason: 'needs_clinical_context_before_scheduling'
            };
        }

        // 3️⃣ IDADE (depois da queixa)
        if (missing.needsAge) {
            return {
                action: 'ask_age',
                handler: 'leadQualificationHandler',
                reason: 'needsAge'
            };
        }

        // 4️⃣ PERÍODO (depois da idade)
        if (missing.needsPeriod) {
            return {
                action: 'ask_period',
                handler: 'leadQualificationHandler',
                reason: 'needsPeriod'
            };
        }

        // 5️⃣ SLOT ESCOLHIDO → Coleta nome / confirma
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

        // 6️⃣ TEM TUDO (terapia + queixa + idade + período) → Busca/Mostra slots
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
    // 6️⃣ FORÇAR SCHEDULING SE TEM TERAPIA MAS FALTA QUEIXA
    // =========================
    // Se não está em 'scheduling' mas tem terapia e falta queixa, força coleta
    if (!missing.needsTherapy && missing.needsComplaint) {
        return {
            action: 'collect_complaint',
            handler: 'complaintCollectionHandler',
            reason: 'awaiting_clinical_context'
        };
    }

    // =========================
    // 🆕 REGRA 6.5: TEM TODOS OS DADOS MAS INTENT NÃO É SCHEDULING
    // Se já coletou terapia + queixa + idade + período, vai pro booking mesmo 
    // que o intent seja "duvida_geral" ou outro
    // =========================
    if (!missing.needsTherapy && !missing.needsComplaint && !missing.needsAge && !missing.needsPeriod) {
        return {
            action: 'booking',
            handler: 'bookingHandler',
            reason: 'all_data_collected_implicit'
        };
    }

    // =========================
    // 7️⃣ SLOT ESCOLHIDO (FORA DO SCHEDULING)
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