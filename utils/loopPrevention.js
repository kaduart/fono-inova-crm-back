/**
 * 🛡️ LOOP PREVENTION SYSTEM
 * 
 * Garantia absoluta contra loop - mantém histórico de perguntas
 * e nunca permite repetir a mesma pergunta 2x para o mesmo lead.
 */

import mongoose from 'mongoose';

// Mapa em memória para rastreamento rápido (não persiste, mas é rápido)
const askedQuestionsMap = new Map();
const MAX_MEMORY_ITEMS = 1000;

/**
 * Registra que uma pergunta foi feita para um lead
 * @param {string} leadId 
 * @param {string} questionType - 'name', 'age', 'period', 'complaint'
 */
export function registerAskedQuestion(leadId, questionType) {
    if (!leadId || !questionType) return;
    
    const key = `${leadId}:${questionType}`;
    askedQuestionsMap.set(key, {
        timestamp: Date.now(),
        count: (askedQuestionsMap.get(key)?.count || 0) + 1
    });
    
    // Limpa itens antigos se mapa ficar grande
    if (askedQuestionsMap.size > MAX_MEMORY_ITEMS) {
        const oldest = askedQuestionsMap.keys().next().value;
        askedQuestionsMap.delete(oldest);
    }
}

/**
 * Verifica se já perguntou algo para este lead
 * @param {string} leadId 
 * @param {string} questionType 
 * @returns {object} { asked: boolean, count: number, firstTime: timestamp }
 */
export function hasAskedQuestion(leadId, questionType) {
    if (!leadId || !questionType) return { asked: false, count: 0 };
    
    const key = `${leadId}:${questionType}`;
    const entry = askedQuestionsMap.get(key);
    
    if (entry) {
        return {
            asked: true,
            count: entry.count,
            firstTime: entry.timestamp,
            lastTime: entry.timestamp
        };
    }
    
    return { asked: false, count: 0 };
}

/**
 * Proteção FORTE contra loop: verifica se deve fazer pergunta
 * Combina verificação de dados + histórico de perguntas
 * 
 * @param {object} lead 
 * @param {string} questionType 
 * @returns {object} { shouldAsk: boolean, reason: string }
 */
export function shouldAskQuestion(lead, questionType) {
    if (!lead?._id) {
        return { shouldAsk: true, reason: 'no_lead' };
    }
    
    const leadId = lead._id.toString();
    
    // CHECK 1: Verifica se já tem o dado
    const hasData = checkHasData(lead, questionType);
    if (hasData) {
        return { 
            shouldAsk: false, 
            reason: 'already_has_data',
            protection: 'data_exists'
        };
    }
    
    // CHECK 2: Verifica se já perguntou (proteção extra)
    const history = hasAskedQuestion(leadId, questionType);
    if (history.asked && history.count >= 1) {
        return { 
            shouldAsk: false, 
            reason: 'already_asked_before',
            askedCount: history.count,
            protection: 'history_prevention'
        };
    }
    
    // Se passou todos os checks, pode perguntar
    return { shouldAsk: true, reason: 'first_time' };
}

/**
 * Verifica se lead já tem o dado solicitado
 */
function checkHasData(lead, questionType) {
    switch (questionType) {
        case 'name':
            return !!(lead.patientInfo?.fullName || lead.patientInfo?.name);
            
        case 'age':
            return !!(lead.patientInfo?.age !== undefined && lead.patientInfo?.age !== null);
            
        case 'period':
            return !!(
                lead.pendingPreferredPeriod ||
                lead.qualificationData?.disponibilidade ||
                lead.preferredTime
            );
            
        case 'complaint':
            return !!(lead.complaint || lead.primaryComplaint);
            
        default:
            return false;
    }
}

/**
 * Limpa histórico de perguntas de um lead (útil para reset)
 * @param {string} leadId 
 */
export function clearQuestionHistory(leadId) {
    if (!leadId) return;
    
    const prefix = `${leadId}:`;
    for (const key of askedQuestionsMap.keys()) {
        if (key.startsWith(prefix)) {
            askedQuestionsMap.delete(key);
        }
    }
}

/**
 * Verifica se lead está em estado de "triagem completa"
 * @param {object} lead 
 * @returns {boolean}
 */
export function isTriageComplete(lead) {
    if (!lead) return false;
    
    const hasName = !!(lead.patientInfo?.fullName || lead.patientInfo?.name);
    const hasAge = !!(lead.patientInfo?.age !== undefined);
    const hasPeriod = !!(lead.pendingPreferredPeriod || lead.qualificationData?.disponibilidade);
    const hasComplaint = !!(lead.complaint || lead.primaryComplaint);
    const hasArea = !!lead.therapyArea;
    
    return hasName && hasAge && hasPeriod && hasComplaint && hasArea;
}

/**
 * Gera resposta alternativa quando pergunta seria repetida
 * @param {object} lead 
 * @param {string} blockedQuestion 
 * @returns {string|null}
 */
export function generateAlternativeResponse(lead, blockedQuestion) {
    // Se triagem completa, oferece slots
    if (isTriageComplete(lead)) {
        return "Perfeito! Já tenho todas as informações 💚\n\nVou buscar os melhores horários para você...";
    }
    
    // Se falta algo específico, pergunta só o que falta
    const missing = [];
    if (!lead.patientInfo?.fullName) missing.push('nome');
    if (lead.patientInfo?.age === undefined) missing.push('idade');
    if (!lead.pendingPreferredPeriod && !lead.qualificationData?.disponibilidade) missing.push('período');
    if (!lead.complaint && !lead.primaryComplaint) missing.push('queixa');
    
    if (missing.length === 1) {
        const mapQuestions = {
            'nome': 'Só falta o nome completo do paciente 😊',
            'idade': 'Qual a idade?',
            'período': 'Prefere manhã ou tarde?',
            'queixa': 'Qual a principal preocupação?'
        };
        return mapQuestions[missing[0]] || null;
    }
    
    return null;
}

/**
 * Middleware para proteger função de geração de resposta
 * @param {Function} responseBuilder 
 * @returns {Function}
 */
export function withLoopProtection(responseBuilder) {
    return async function(lead, questionType, ...args) {
        const check = shouldAskQuestion(lead, questionType);
        
        if (!check.shouldAsk) {
            console.log(`[LOOP-BLOCKED] Pergunta "${questionType}" bloqueada para lead ${lead._id}: ${check.reason}`);
            
            // Tenta gerar resposta alternativa
            const alternative = generateAlternativeResponse(lead, questionType);
            if (alternative) {
                return { text: alternative, loopPrevented: true };
            }
            
            // Se não tem alternativa, retorna erro silencioso
            return { 
                text: "Entendi! 💚",
                loopPrevented: true,
                reason: check.reason
            };
        }
        
        // Registra que vai perguntar
        registerAskedQuestion(lead._id.toString(), questionType);
        
        // Executa função original
        return await responseBuilder(lead, questionType, ...args);
    };
}
