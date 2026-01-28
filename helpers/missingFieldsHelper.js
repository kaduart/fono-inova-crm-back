

/**
 * Centraliza a lógica de "o que falta coletar"
 * Usa apenas campos existentes no Lead (pending*, patientInfo)
 */

export const AWAITING_FIELDS = {
    THERAPY: 'therapy',
    COMPLAINT: 'complaint',
    AGE: 'age',
    PERIOD: 'period',
    SLOT: 'slot',
    SLOT_SELECTION: 'slot_selection',
    NAME: 'patient_name'
};

export function buildMissingFields({
    hasTherapy,
    hasComplaint,
    hasAge,
    hasPeriod,
    hasSlotsToShow,
    hasChosenSlot,
    patientName
}) {
    const missing = {
        needsTherapy: !hasTherapy,
        needsComplaint: hasTherapy && !hasComplaint,
        needsAge: hasTherapy && hasComplaint && !hasAge,
        needsPeriod: hasTherapy && hasComplaint && hasAge && !hasPeriod,
        needsSlot: hasTherapy && hasComplaint && hasAge && hasPeriod && !hasSlotsToShow && !hasChosenSlot,
        needsSlotSelection: hasSlotsToShow && !hasChosenSlot,
        needsName: hasChosenSlot && !patientName
    };

    // Determina qual campo estamos esperando AGORA (para retomada)
    missing.currentAwaiting = determineCurrentAwaiting(missing);

    return missing;
}

function determineCurrentAwaiting(missing) {
    if (missing.needsComplaint) return AWAITING_FIELDS.COMPLAINT;
    if (missing.needsAge) return AWAITING_FIELDS.AGE;
    if (missing.needsPeriod) return AWAITING_FIELDS.PERIOD;
    if (missing.needsSlotSelection) return AWAITING_FIELDS.SLOT_SELECTION;
    if (missing.needsName) return AWAITING_FIELDS.NAME;
    return null;
}

export function messageAnswersAwaiting(text, extractedInfo, awaitingField) {
    if (!awaitingField) return false;

    const validators = {
        [AWAITING_FIELDS.AGE]: () =>
            extractedInfo?.age ||
            extractedInfo?.idade ||
            /\b(\d+)\s*anos?\b/i.test(text),

        [AWAITING_FIELDS.COMPLAINT]: () =>
            extractedInfo?.queixa ||
            extractedInfo?.sintomas ||
            text.length > 10,

        [AWAITING_FIELDS.PERIOD]: () =>
            extractedInfo?.preferredPeriod ||
            extractedInfo?.disponibilidade ||
            /\b(manh[aã]|tard|noit)\b/i.test(text),

        [AWAITING_FIELDS.SLOT_SELECTION]: () =>
            /^(a|b|c|1|2|3|primeira|segunda|terceira|opção)\b/i.test(text.trim()),

        [AWAITING_FIELDS.NAME]: () =>
            extractedInfo?.patientName ||
            (text.trim().length > 2 && !/^(sim|não|ok|beleza)$/i.test(text.trim()))
    };

    return validators[awaitingField] ? validators[awaitingField]() : false;
}