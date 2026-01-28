/**
 * Detecta interrupções naturais e retomadas
 * Usa checkpoint derivado dos pending* existentes no Lead
 */

import { messageAnswersAwaiting } from './missingFieldsHelper.js';

export function detectTopicShift({
    currentIntent,
    currentAwaiting,
    messageText,
    hasPendingScheduling,
    extractedInfo
}) {
    // Se não estamos esperando nada específico, não é interrupção
    if (!currentAwaiting || !hasPendingScheduling) {
        return { isInterruption: false };
    }

    // Se a mensagem responde o que estamos esperando, é retomada (não interrupção)
    const answersPending = messageAnswersAwaiting(messageText, extractedInfo, currentAwaiting);
    if (answersPending) {
        return {
            isInterruption: false,
            isNaturalResume: true,
            resumedField: currentAwaiting
        };
    }

    // Se é intent lateral (preço, info) enquanto esperávamos algo = INTERRUPIÇÃO
    const sideIntents = ['price', 'therapy_info', 'general_info'];
    if (sideIntents.includes(currentIntent)) {
        return {
            isInterruption: true,
            interruptedField: currentAwaiting, // O que estávamos esperando antes
            sideIntent: currentIntent
        };
    }

    return { isInterruption: false };
}

export function buildResumptionMessage(missing) {
    const messages = {
        complaint: 'Me conta rapidinho a queixa principal? 💚',
        age: 'Qual a idade do paciente? 💚',
        period: 'Prefere manhã ou tarde? 💚',
        slot_selection: 'Quando quiser continuar, é só escolher A, B ou C 💚',
        patient_name: 'Me confirma o nome completo? 💚'
    };

    return missing.currentAwaiting ? messages[missing.currentAwaiting] : null;
}