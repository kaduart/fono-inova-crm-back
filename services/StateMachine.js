// services/StateMachine.js
// FSM Determinística para Amanda V8
// Reusa helpers existentes: intentHelper, missingFieldsHelper, flowStateHelper
// IA = APENAS NLU (interpretar texto), nunca decidir próximo estado

import { isSideIntent, normalizeIntent, INTENT_TYPES } from '../helpers/intentHelper.js';
import { buildResumptionMessage, detectTopicShift } from '../helpers/flowStateHelper.js';
import { AWAITING_FIELDS } from '../helpers/missingFieldsHelper.js';
import Leads from '../models/Leads.js';
import Logger from './utils/Logger.js';

const logger = new Logger('StateMachine');

// ═══════════════════════════════════════════
// DEFINIÇÃO DE ESTADOS E TRANSIÇÕES
// ═══════════════════════════════════════════

export const STATES = {
    IDLE: 'IDLE',
    GREETING: 'GREETING',
    COLLECT_THERAPY: 'COLLECT_THERAPY',
    COLLECT_NEURO_TYPE: 'COLLECT_NEURO_TYPE',  // laudo vs acompanhamento (neuropsico)
    COLLECT_NAME: 'COLLECT_NAME',
    COLLECT_BIRTH: 'COLLECT_BIRTH',
    COLLECT_COMPLAINT: 'COLLECT_COMPLAINT',
    COLLECT_PERIOD: 'COLLECT_PERIOD',
    SHOW_SLOTS: 'SHOW_SLOTS',
    CONFIRM_BOOKING: 'CONFIRM_BOOKING',
    COLLECT_PATIENT_DATA: 'COLLECT_PATIENT_DATA',
    BOOKED: 'BOOKED',
    INTERRUPTED: 'INTERRUPTED',
    HANDOFF: 'HANDOFF',
};

// Transições lineares: de um estado vai para o próximo
const LINEAR_FLOW = [
    STATES.IDLE,
    STATES.GREETING,
    STATES.COLLECT_THERAPY,
    STATES.COLLECT_COMPLAINT,
    STATES.COLLECT_BIRTH,
    STATES.COLLECT_PERIOD,
    STATES.SHOW_SLOTS,
    STATES.CONFIRM_BOOKING,
    STATES.COLLECT_PATIENT_DATA,
    STATES.BOOKED,
];

// Intents que causam interrupção (não mudam estado, só empilham)
const GLOBAL_INTENTS = {
    PRICE_QUERY: /(pre[çc]o|valor|custa|quanto\s*(fica|é|sai)|tabela)/i,
    LOCATION_QUERY: /(endere[çc]o|onde\s*fica|localiza[çc][ãa]o|como\s*cheg)/i,
    INSURANCE_QUERY: /(plano|conv[eê]nio|unimed|amil|bradesco\s*sa[uú]de|sulam[eé]rica|aceita)/i,
    CONTACT_QUERY: /(whatsapp|telefone|contato|ligar)/i,
    HOURS_QUERY: /(hor[aá]rio\s*de\s*funcionamento|que\s*horas\s*(abre|fecha)|funciona)/i,
};

const MAX_RETRIES = 3; // Após 3 erros no mesmo estado → handoff humano

// ═══════════════════════════════════════════
// DETECÇÃO DE INTERRUPÇÃO GLOBAL
// ═══════════════════════════════════════════

/**
 * Detecta se a mensagem é uma "pergunta lateral" (preço, endereço, etc.)
 * Retorna o tipo de interrupção ou null
 */
export function detectGlobalIntent(text) {
    if (!text) return null;
    for (const [intentName, regex] of Object.entries(GLOBAL_INTENTS)) {
        if (regex.test(text)) return intentName;
    }
    return null;
}

// ═══════════════════════════════════════════
// INTERRUPÇÃO: EMPILHA ESTADO ATUAL
// ═══════════════════════════════════════════

/**
 * Suspende o estado atual e empilha na stateStack.
 * Retorna o lead com o novo estado INTERRUPTED.
 */
export async function suspendState(leadId, currentState, stateData, reason) {
    logger.info('STATE_SUSPENDED', { leadId, from: currentState, reason });

    const updated = await Leads.findByIdAndUpdate(
        leadId,
        {
            $push: {
                stateStack: {
                    state: currentState,
                    data: stateData || {},
                    suspendedAt: new Date(),
                    reason,
                }
            },
            $set: {
                currentState: STATES.INTERRUPTED,
            }
        },
        { new: true }
    );

    return updated;
}

// ═══════════════════════════════════════════
// RETOMADA: DESEMPILHA ESTADO ANTERIOR
// ═══════════════════════════════════════════

/**
 * Volta ao estado anterior (topo da pilha).
 * Retorna { state, data } do estado restaurado ou null.
 */
export async function resumeState(leadId) {
    const lead = await Leads.findById(leadId).lean();
    const stack = lead?.stateStack || [];

    if (stack.length === 0) {
        logger.warn('RESUME_EMPTY_STACK', { leadId });
        return null;
    }

    const lastState = stack[stack.length - 1];

    const updated = await Leads.findByIdAndUpdate(
        leadId,
        {
            $set: {
                currentState: lastState.state,
                stateData: lastState.data || {},
            },
            $pop: { stateStack: 1 } // Remove o topo
        },
        { new: true }
    );

    logger.info('STATE_RESUMED', { leadId, to: lastState.state, reason: lastState.reason });

    return {
        state: lastState.state,
        data: lastState.data,
        lead: updated,
    };
}

// ═══════════════════════════════════════════
// TRANSIÇÃO: AVANÇA PARA O PRÓXIMO ESTADO
// ═══════════════════════════════════════════

/**
 * Avança o lead para o próximo estado na sequência linear.
 * Reseta o retryCount.
 */
export async function advanceState(leadId, newStateData = {}) {
    const lead = await Leads.findById(leadId).lean();
    const current = lead?.currentState || STATES.IDLE;
    const currentIndex = LINEAR_FLOW.indexOf(current);

    if (currentIndex === -1 || currentIndex >= LINEAR_FLOW.length - 1) {
        logger.warn('ADVANCE_END_OF_FLOW', { leadId, current });
        return lead;
    }

    const nextState = LINEAR_FLOW[currentIndex + 1];

    const mergedData = { ...(lead.stateData || {}), ...newStateData };

    const updated = await Leads.findByIdAndUpdate(
        leadId,
        {
            $set: {
                currentState: nextState,
                stateData: mergedData,
                retryCount: 0,
            }
        },
        { new: true }
    );

    logger.info('STATE_ADVANCED', { leadId, from: current, to: nextState });
    return updated;
}

/**
 * Pula para um estado específico (para pular etapas quando dados já existem).
 */
export async function jumpToState(leadId, targetState, newStateData = {}) {
    const lead = await Leads.findById(leadId).lean();
    const mergedData = { ...(lead?.stateData || {}), ...newStateData };

    const updated = await Leads.findByIdAndUpdate(
        leadId,
        {
            $set: {
                currentState: targetState,
                stateData: mergedData,
                retryCount: 0,
            }
        },
        { new: true }
    );

    logger.info('STATE_JUMPED', { leadId, to: targetState });
    return updated;
}

// ═══════════════════════════════════════════
// RETRY: CONTROLE DE LOOPS
// ═══════════════════════════════════════════

/**
 * Incrementa o retry e retorna o novo count.
 * Se atingir MAX_RETRIES, force handoff.
 */
export async function incrementRetry(leadId) {
    const updated = await Leads.findByIdAndUpdate(
        leadId,
        { $inc: { retryCount: 1 } },
        { new: true }
    );

    const count = updated?.retryCount || 0;

    if (count >= MAX_RETRIES) {
        logger.warn('MAX_RETRIES_REACHED', { leadId, count });
        await Leads.findByIdAndUpdate(leadId, {
            $set: { currentState: STATES.HANDOFF, retryCount: 0 }
        });
        return { count, retryCount: count, handoff: true };
    }

    return { count, retryCount: count, handoff: false };
}

// ═══════════════════════════════════════════
// HELPER: GANCHO NATURAL DE RETOMADA
// ═══════════════════════════════════════════

const RESUME_HINTS = {
    [STATES.COLLECT_THERAPY]: '...voltando ao que importa: qual especialidade você procura? 💚',
    [STATES.COLLECT_NEURO_TYPE]: '...voltando: você precisa de um *laudo neuropsicológico* ou *acompanhamento terapêutico*? 💚',
    [STATES.COLLECT_NAME]: '...continuando de onde paramos: qual o nome completo do paciente? 💚',
    [STATES.COLLECT_BIRTH]: '...voltando ao agendamento: qual a data de nascimento? 💚',
    [STATES.COLLECT_COMPLAINT]: '...retomando: qual é a situação principal que gostaria de tratar? 💚',
    [STATES.COLLECT_PERIOD]: '...e sobre o horário: prefere manhã ou tarde? ☀️🌙',
    [STATES.SHOW_SLOTS]: '...continuando: qual opção de horário prefere? (A, B ou C) 💚',
    [STATES.CONFIRM_BOOKING]: '...voltando: posso confirmar esse horário? 💚',
    [STATES.COLLECT_PATIENT_DATA]: '...só falta confirmar os dados do paciente! 💚',
};

/**
 * Gera a frase de retomada natural para o estado suspenso.
 */
export function getResumeHint(state) {
    return RESUME_HINTS[state] || '...continuando de onde paramos! 💚';
}

/**
 * Verifica se a mensagem é uma resposta direta ao estado suspenso.
 * Ex: se estava em COLLECT_NAME e o usuário manda "João Silva" → é retomada automática.
 */
export function isAutoResume(text, suspendedState) {
    if (!text || !suspendedState) return false;
    const t = text.trim();

    const checks = {
        // Retomada quando user manda especialidade enquanto estava em COLLECT_THERAPY suspenso
        // Sem \b no final — "neuropsicologia" contém "neuropsico" como prefixo
        [STATES.COLLECT_THERAPY]: () => /(^|\s)(fono|psico|fisio|neuropsico|ocupa[cç]|musico|psicopedag|linguinha|freio\s*lingual|neuropsi)/i.test(t),
        // Retomada quando user responde laudo/acompanhamento enquanto estava em COLLECT_NEURO_TYPE suspenso
        [STATES.COLLECT_NEURO_TYPE]: () => /\b(laudo|relat[oó]rio|diagn[oó]stico|acompanhamento|terapia|sess[oõ]es?)\b/i.test(t),
        [STATES.COLLECT_NAME]: () => t.length >= 3 && /^[A-Za-zÀ-ÿ\s]+$/.test(t) && !/(preço|valor|endereço|plano)/i.test(t),
        [STATES.COLLECT_BIRTH]: () => /\d{2}[\/-]\d{2}[\/-]\d{2,4}/.test(t) || /\d+\s*anos?/i.test(t),
        [STATES.COLLECT_PERIOD]: () => /\b(manh[aã]|tard|noit)/i.test(t),
        [STATES.SHOW_SLOTS]: () => /^[A-Fa-f1-6]$/i.test(t.charAt(0)),
        [STATES.CONFIRM_BOOKING]: () => /^(sim|confirmar?|isso|pode|bora|ok|yes)/i.test(t),
    };

    return checks[suspendedState] ? checks[suspendedState]() : false;
}

export default {
    STATES,
    LINEAR_FLOW,
    detectGlobalIntent,
    suspendState,
    resumeState,
    advanceState,
    jumpToState,
    incrementRetry,
    getResumeHint,
    isAutoResume,
};
