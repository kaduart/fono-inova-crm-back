import { isSideIntent } from './intentHelper.js';
import { messageAnswersAwaiting } from './missingFieldsHelper.js';

/**
 * Detecta interrupções naturais e retomadas
 * Usa checkpoint derivado dos pending* existentes no Lead
 */

export function detectTopicShift({
    currentIntent,
    messageText,
    lead,
    bookingContext,
    missing
}) {
    // Determina se estamos em meio a um agendamento
    const hasSchedulingContext =
        lead?.therapyArea ||
        lead?.primaryComplaint ||
        bookingContext?.slots?.primary ||
        bookingContext?.chosenSlot ||
        (!missing?.needsTherapy && !missing?.needsComplaint);

    // Se não estamos em agendamento, não é interrupção
    if (!hasSchedulingContext) {
        return { isInterruption: false };
    }

    // Se a mensagem responde o que estamos esperando, é retomada
    if (missing?.currentAwaiting && messageAnswersAwaiting(messageText, {}, missing.currentAwaiting)) {
        return {
            isInterruption: false,
            isNaturalResume: true,
            resumedField: missing.currentAwaiting
        };
    }

    // Se é intent lateral enquanto aguardamos algo = INTERRUPIÇÃO
    if (isSideIntent(currentIntent)) {
        return {
            isInterruption: true,
            interruptedField: missing?.currentAwaiting || 'unknown',
            sideIntent: currentIntent
        };
    }

    return { isInterruption: false };
}

export function buildResumptionMessage(missing) {
    const messages = {
        therapy: 'Para te ajudar melhor, qual é a especialidade que procura?',
        complaint: 'Voltando ao agendamento: qual é a situação principal que gostaria de tratar? 💚',
        age: 'Para buscar os horários certinhos, qual a idade do paciente? 💚',
        period: 'Prefere manhã ou tarde para o atendimento? ☀️🌙',
        slot_selection: 'Quando quiser continuar, é só escolher A, B ou C 💚',
        patient_name: 'Só falta o nome completo para confirmarmos! 💚'
    };

    return missing.currentAwaiting ? messages[missing.currentAwaiting] : null;
}