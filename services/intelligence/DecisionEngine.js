/**
 * 🧠 DecisionEngine - Versão 3.0 (Arquitetura Respond+Resume)
 * 
 * FILOSOFIA: NUNCA ignore o usuário. SEMPRE responda primeiro, depois retome.
 * Não há árvore linear. Há prioridades dinâmicas baseadas no contexto.
 */

import { generateWarmRecall } from '../leadContext.js';
import Logger from '../utils/Logger.js';
import { buildResponse } from './naturalResponseBuilder.js';
import { createSmartFollowupForLead } from '../followupOrchestrator.js';
import { getInvestmentText, buildValueFirstResponse } from '../../config/pricing.js';
import { trackDecision, trackFunnelStep } from '../analytics/decisionTracking.js';

// 🚀 AMANDA 4.2 - Módulos de Inteligência Avançada
import { calculateAccumulativeScore, prepareIntentScoreForSave } from './intentScorePersistence.js';
import { prepareMemoryForSave, formatMemoryForPrompt } from './memoryWindow.js';
import { determinePricingStrategy, buildStrategicPriceText } from './pricingStrategy.js';
import { determineMode, buildModeInstruction, prepareModeForSave } from './conversationMode.js';
import { detectGhost, selectRecoveryMessage } from './ghostRecovery.js';

const logger = new Logger('DecisionEngine');

// 🎯 Constantes de Prioridade
export const PRIORITY = {
    P0_WARM_RECALL: 'P0_warm_recall',
    P0_URGENCY: 'P0_urgency',
    P1_ACOLHIMENTO: 'P1_acolhimento',
    P2_SMART_RESPONSE: 'P2_smart_response',
    P2_WARM_LEAD: 'P2_warm_lead',
    P3_COLLECTION: 'P3_collection'
};

// 🌊 Constantes de Fluxo
export const FLOW = {
    F2_VALUE_BEFORE_PRICE: 'F2_value_before_price',
    F3_INSURANCE_BRIDGE: 'F3_insurance_bridge',
    F4_HANDOVER: 'F4_seamless_handover',
    F5_SKIP_REPETITION: 'F5_skip_repetition',
    F6_EMOTIONAL_SUPPORT: 'F6_emotional_support',
    F7_URGENCY_PRIORITY: 'F7_urgency_priority'
};

// 🔧 Helper para logs estruturados + tracking
function logDecision(step, data, leadId = null) {
    logger.info(`[DECISION_FLOW] ${step}`, data);
    if (leadId) trackDecision(leadId, step, data);
}
function logDebug(step, data) {
    logger.debug(`[DECISION_FLOW] ${step}`, data);
}

/**
 * 🔀 FUNÇÃO PRINCIPAL: decide()
 * 
 * Arquitetura de Prioridades:
 * P0: Warm Recall (lead retornando após 24h+)
 * P1: Acolhimento Emocional (expressou dor)
 * P2: Smart Response (pergunta direta: preço, endereço, etc)
 * P3: Continue Collection (continuar coleta do que falta)
 */
export async function decide({ analysis, memory, flags, lead, contextPack, message, missing = {}, chatContext = null }) {
    logDecision('START', {
        leadId: lead?._id?.toString(),
        messageText: message?.text?.substring(0, 50),
        chatContextFlags: {
            awaitingField: chatContext?.lastExtractedInfo?.awaitingField,
            awaitingComplaint: chatContext?.lastExtractedInfo?.awaitingComplaint,
            awaitingAge: chatContext?.lastExtractedInfo?.awaitingAge,
            awaitingPeriod: chatContext?.lastExtractedInfo?.awaitingPeriod
        },
        lastContact: contextPack?.lastDate,
        hoursSince: contextPack?.lastDate ? (Date.now() - new Date(contextPack.lastDate).getTime()) / (1000 * 60 * 60) : null,
        flags: {
            userExpressedPain: flags?.userExpressedPain || flags?.hasPain,
            asksPrice: flags?.asksPrice,
            asksAddress: flags?.asksAddress,
            asksSchedule: flags?.asksSchedule
        },
        memory: {
            hasTherapy: !!memory?.therapyArea,
            hasComplaint: !!(memory?.complaint || memory?.primaryComplaint),
            hasAge: !!(memory?.patientAge || memory?.patientInfo?.age),
            hasPeriod: !!(memory?.preferredPeriod || memory?.pendingPreferredPeriod)
        }
    });

    // 🎯 DETECTA CONTEXTO EMOCIONAL PARA IA (nada engessado!)
    const emotionalContext = detectEmotionalContext(message?.text, memory, flags);
    const enrichedMemory = enrichContextForAI(memory, flags, emotionalContext);
    
    // Log do contexto detectado
    if (Object.values(emotionalContext).some(v => v)) {
        logDebug('EMOTIONAL_CONTEXT_DETECTED', {
            leadId: lead?._id?.toString(),
            ...emotionalContext
        });
    }
    
    // 🚀 AMANDA 4.2: INTENT SCORE ACUMULATIVO COM DECAY
    const previousScore = lead?.qualificationData?.intentScore || 0;
    const lastInteraction = lead?.qualificationData?.lastIntentUpdate;
    
    // Calcula sinais atuais (0-100)
    const currentSignals = calculateCurrentSignals(flags, message?.text, emotionalContext);
    
    // Calcula score acumulativo com decay
    const intentScoreResult = calculateAccumulativeScore({
        previousScore,
        currentSignals,
        lastInteraction,
        leadId: lead?._id?.toString()
    });
    
    // 🎭 AMANDA 4.2: DETERMINA MODO DE CONVERSAÇÃO
    const conversationMode = determineMode(intentScoreResult.score, intentScoreResult.trend);
    const modeInstruction = buildModeInstruction(conversationMode, {
        score: intentScoreResult.score,
        patientName: memory?.patientName,
        patientAge: memory?.patientAge,
        therapyArea: memory?.therapyArea
    });
    
    logDecision('INTENT_SCORE_CALCULATED', {
        leadId: lead?._id?.toString(),
        score: intentScoreResult.score,
        previousScore: intentScoreResult.previousScore,
        trend: intentScoreResult.trend,
        mode: conversationMode,
        isHot: intentScoreResult.isHot,
        isWarm: intentScoreResult.isWarm
    });

    // ============================================================================
    // PRIORIDADE 0: WARM RECALL (Lead retornando após 24h+)
    // ============================================================================
    const hoursSinceLastContact = contextPack?.lastDate
        ? (Date.now() - new Date(contextPack.lastDate).getTime()) / (1000 * 60 * 60)
        : 0;

    if (hoursSinceLastContact > 24) {
        logDecision('PRIORITY_P0_WARM_RECALL', { hoursSinceLastContact });
        return warmRecall(contextPack, memory, lead);
    }

    // ============================================================================
    // PRIORIDADE 0.5: URGÊNCIA DESENVOLVIMENTAL (Bebês ≤6 anos)
    // ============================================================================
    const childAge = memory?.patientAge || memory?.patientInfo?.age || analysis?.extractedInfo?.idade;
    const ageNum = childAge ? parseInt(childAge, 10) : null;
    const isUrgentAge = ageNum && ageNum <= 6;
    const isFirstContactAboutChild = isUrgentAge && (!memory?.messageCount || memory.messageCount <= 2);
    
    if (isFirstContactAboutChild && !memory?.urgencyAcknowledged) {
        logDecision('PRIORITY_P0_5_URGENCY', { childAge: ageNum, reason: 'developmental_window' });
        return handleDevelopmentalUrgency(memory, ageNum, chatContext);
    }

    // ============================================================================
    // PRIORIDADE 1: ACOLHIMENTO EMOCIONAL (Primeira vez que expressa dor)
    // ============================================================================
    const expressedPain = flags?.userExpressedPain || flags?.hasPain;
    const painAcknowledged = memory?.painAcknowledged || lead?.qualificationData?.painAcknowledged;

    if (expressedPain && !painAcknowledged) {
        logDecision('PRIORITY_P1_ACKNOWLEDGE_PAIN', { expressedPain, painAcknowledged });
        return acknowledgePain(enrichedMemory, chatContext);
    }

    // ============================================================================
    // PRIORIDADE 2: SMART RESPONSE (Pergunta direta no meio do flow)
    // ============================================================================
    const directQuestion = detectDirectQuestion(flags);
    if (directQuestion) {
        logDecision('PRIORITY_P2_SMART_RESPONSE', { directQuestion, flags: Object.keys(flags || {}) });
        // 🔥 PASSA analysis.extractedInfo para enriquecer o memory
        const inferredFromAnalysis = {
            therapy: analysis?.therapyArea || analysis?.extractedInfo?.especialidade,
            age: analysis?.extractedInfo?.idade,
            period: analysis?.extractedInfo?.disponibilidade,
            complaint: analysis?.extractedInfo?.queixa
        };
        return smartResponse(directQuestion, flags, enrichedMemory, analysis, inferredFromAnalysis, missing, chatContext);
    }

    // ============================================================================
    // PRIORIDADE 2.5: LEAD MORNO (Vai pensar/decidir depois)
    // ============================================================================
    const warmBlock = detectWarmLead(message?.text || '');
    if (warmBlock) {
        logDecision('PRIORITY_P2_5_WARM_LEAD', { blockType: warmBlock.type, delay: warmBlock.delayHours });
        return handleWarmLead(warmBlock, lead, memory, chatContext);
    }

    // ============================================================================
    // PRIORIDADE 3: CONTINUE COLLECTION (Continuar coleta naturalmente)
    // ============================================================================
    logDecision('PRIORITY_P3_CONTINUE_COLLECTION', { memoryKeys: Object.keys(memory || {}) });
    // 🔥 MESCLA enrichedMemory com analysis.extractedInfo para ter dados atualizados
    const finalMemory = {
        ...enrichedMemory,
        ...(analysis?.extractedInfo?.complaint && { complaint: analysis.extractedInfo.complaint }),
        ...(analysis?.extractedInfo?.idade && { patientAge: analysis.extractedInfo.idade }),
        ...(analysis?.extractedInfo?.disponibilidade && { preferredPeriod: analysis.extractedInfo.disponibilidade }),
        ...(analysis?.therapyArea && { therapyArea: analysis.therapyArea }),
        // 🔥 CRÍTICO: Preservar dados de múltiplas terapias
        ...(memory?.hasMultipleTherapies && { hasMultipleTherapies: memory.hasMultipleTherapies }),
        ...(memory?.allDetectedTherapies && { allDetectedTherapies: memory.allDetectedTherapies })
    };
    return continueCollection(finalMemory, chatContext, message?.text, flags);
}

// ============================================================================
// 🧮 CALCULA SINAIS ATUAIS (0-100) para Intent Score
// ============================================================================
function calculateCurrentSignals(flags = {}, message = '', emotionalContext = {}) {
    let signals = 0;
    
    // Sinais de alta intenção
    if (flags.wantsSchedule || /\b(quero agendar|vamos marcar|pode agendar|quero marcar)\b/i.test(message)) {
        signals += 50;
    } else if (flags.asksSchedule || /\b(hor[áa]rio|vaga|disponibilidade)\b/i.test(message)) {
        signals += 25;
    }
    
    // Pergunta de preço
    if (flags.asksPrice || /\b(quanto|custa|pre[çc]o|valor|investimento)\b/i.test(message)) {
        signals += 15;
    }
    
    // Resposta rápida (assumido se não passou muito tempo)
    // Nota: tempo real calculado no persistence
    
    // Dados completos
    if (flags.hasCompleteData || /\b(dados completos|tudo certo)\b/i.test(message)) {
        signals += 30;
    }
    
    // Urgência
    if (emotionalContext.expressedUrgency || /\b(urgente|r[áa]pido|logo|desesperad)\b/i.test(message)) {
        signals += 15;
    }
    
    // Intenção de pacote
    if (flags.asksPackage || /\b(pacote|pacotes|v[áa]rias sess[õo]es)\b/i.test(message)) {
        signals += 20;
    }
    
    return Math.min(100, signals);
}

// ============================================================================
// 🎯 IMPLEMENTAÇÃO: WARM RECALL
// ============================================================================
function warmRecall(contextPack, memory, lead) {
    logDebug('WARM_RECALL_START', { leadId: lead?._id?.toString() });

    // Usa generateWarmRecall do ContextPack.js para mensagem personalizada
    const warmRecallText = generateWarmRecall(contextPack, lead);

    const hoursSince = contextPack?.lastDate
        ? Math.round((Date.now() - new Date(contextPack.lastDate).getTime()) / (1000 * 60 * 60))
        : 0;

    const result = {
        action: 'warm_recall',
        handler: 'leadQualificationHandler',
        text: warmRecallText,
        extractedInfo: {
            returningLead: true,
            hoursSinceLastContact: hoursSince,
            warmRecallTier: hoursSince > 72 ? '72h' : hoursSince > 48 ? '48h' : '24h'
        }
    };

    logDecision('WARM_RECALL_RESULT', { action: result.action, hoursSince });
    return result;
}

// ============================================================================
// 💚 IMPLEMENTAÇÃO: ACKNOWLEDGE PAIN
// ============================================================================
function acknowledgePain(memory, chatContext = null) {
    logDebug('ACKNOWLEDGE_PAIN_START', { hasPatientName: !!(memory?.patientInfo?.name || memory?.patientName) });

    const patientName = memory?.patientInfo?.name || memory?.patientName;
    const nameRef = patientName ? `${patientName.split(' ')[0]}` : 'seu filho';

    // Acolhe primeiro
    const acknowledgment = `Entendo sua preocupação 💚 Você fez muito bem em buscar orientação cedo — isso faz toda diferença pro desenvolvimento de ${nameRef}.`;

    // Retoma naturalmente baseado no que falta
    const followUpResult = getSmartFollowUp(memory, false, chatContext);
    const followUpText = typeof followUpResult === 'string' ? followUpResult : followUpResult?.text;

    logDebug('ACKNOWLEDGE_PAIN_FOLLOWUP', { followUpText: followUpText?.substring(0, 50) });

    const result = {
        action: 'acknowledge_pain',
        handler: 'leadQualificationHandler',
        text: followUpText ? `${acknowledgment} ${followUpText} 💚` : `${acknowledgment} 💚`,
        extractedInfo: {
            painAcknowledged: true,
            emotionalSupportProvided: true
        }
    };

    logDecision('ACKNOWLEDGE_PAIN_RESULT', { action: result.action, textLength: result.text.length });
    return result;
}

// ============================================================================
// ⚡ IMPLEMENTAÇÃO: URGÊNCIA DESENVOLVIMENTAL (Bebês ≤6 anos)
// ============================================================================
function handleDevelopmentalUrgency(memory, age, chatContext = null) {
    logDebug('DEVELOPMENTAL_URGENCY_START', { age, hasTherapy: !!memory?.therapyArea });
    
    const patientName = memory?.patientInfo?.name || memory?.patientName;
    const nameRef = patientName ? `${patientName.split(' ')[0]}` : 'seu pequeno';
    
    // Acolhimento com reconhecimento da janela desenvolvimental
    let response = `Que bom que você está buscando orientação 💚 `;
    
    // Explicação da urgência (sutil, não alarmante)
    if (age <= 3) {
        response += `Com ${age} aninhos, o cérebro de ${nameRef} está numa fase super receptiva a estímulos — cada mês realmente faz diferença no desenvolvimento. `;
    } else {
        response += `Com ${age} anos, ainda estamos numa janela importante pro desenvolvimento — quanto antes começarmos, mais efetivo é o trabalho. `;
    }
    
    // Priorização sutil
    response += `Por isso, vou te ajudar com prioridade. `;
    
    // Retoma para coleta rápida
    const followUp = getSmartFollowUp(memory, false, chatContext);
    
    const result = {
        action: 'developmental_urgency',
        handler: 'leadQualificationHandler',
        text: followUp ? `${response}${followUp} 💚` : `${response}Como posso te ajudar? 💚`,
        extractedInfo: {
            urgencyAcknowledged: true,
            developmentalWindow: true,
            childAge: age,
            priorityFlag: 'developmental_urgency'
        }
    };
    
    logDecision('DEVELOPMENTAL_URGENCY_RESULT', { action: result.action, age, textLength: result.text.length });
    return result;
}

// ============================================================================
// 🧠 IMPLEMENTAÇÃO: SMART RESPONSE (Respond + Resume)
// ============================================================================
function smartResponse(questionType, flags, memory, analysis, inferred = {}, missing = {}, chatContext = null) {
    logDebug('SMART_RESPONSE_START', { questionType, hasAnyData: !!(memory?.therapyArea || memory?.complaint || memory?.patientAge) });

    let answer = "";

    // 🔥 Detecta primeiro contato
    const hasAnyData = !!(memory?.therapyArea || memory?.complaint || memory?.patientAge || memory?.lastHandler);
    const acolhimento = !hasAnyData
        ? "Oi! 😊 Que bom que você entrou em contato! Seja bem-vindo(a) à Clínica Fono Inova 💚 "
        : "";

    // =====================================================
    // RESPOSTA IMEDIATA ao que perguntou
    // =====================================================
    // Usa contexto emocional para adaptar, mas mantém estrutura que funciona
    switch (questionType) {
        case 'price':
            answer = buildPriceAnswer(memory, analysis);
            break;

        case 'address':
            answer = "Ficamos na Av. Minas Gerais, 405 - Bairro Jundiaí, Anápolis.";
            break;

        case 'plans':
            answer = buildInsuranceBridgeAnswer(memory);
            break;

        case 'schedule':
            answer = buildScheduleAnswer(memory);
            break;

        case 'specialty':
            answer = "Temos Fono, Psicologia, Terapia Ocupacional, Fisio, Neuropsico e Musicoterapia — equipe multiprofissional integrada.";
            break;

        default:
            answer = "";
    }

    // =====================================================
    // RETOMADA: O que falta coletar?
    // 🔧 CORREÇÃO: Mescla memory + inferred para ter dados atualizados
    // =====================================================
    const enrichedMemory = {
        ...memory,
        ...(inferred.therapy && { therapyArea: inferred.therapy }),
        ...(inferred.age && { patientAge: inferred.age }),
        ...(inferred.period && { preferredPeriod: inferred.period }),
        ...(inferred.complaint && { complaint: inferred.complaint }),
        // 🔥 NOVO: Passar info de múltiplas terapias
        ...(inferred.hasMultipleTherapies && { hasMultipleTherapies: inferred.hasMultipleTherapies }),
        ...(inferred.allDetectedTherapies && { allDetectedTherapies: inferred.allDetectedTherapies }),
        ...(inferred.detectedTherapies && { detectedTherapies: inferred.detectedTherapies })
    };
    const followUpResult = getSmartFollowUp(enrichedMemory, missing?.needsTherapySelection, chatContext);
    const followUpText = typeof followUpResult === 'string' ? followUpResult : followUpResult.text;
    const awaitingField = typeof followUpResult === 'object' ? followUpResult.awaitingField : null;

    // Monta resposta completa com acolhimento (se primeiro contato)
    const fullAnswer = acolhimento + answer;

    const result = {
        action: 'smart_response',
        handler: 'leadQualificationHandler',
        text: followUpText ? `${fullAnswer} ${followUpText} 💚` : `${fullAnswer} 💚`,
        extractedInfo: {
            ...extractFromFlags(flags),
            ...(awaitingField && { awaitingField })
        },
        questionAnswered: questionType
    };

    logDecision('SMART_RESPONSE_RESULT', {
        questionType,
        awaitingField,
        hasAcolhimento: !!acolhimento,
        textLength: result.text.length
    });
    return result;
}

// ============================================================================
// ✅ DETECTAR CONFIRMAÇÃO POSITIVA
// ============================================================================
function isPositiveConfirmation(message, currentAwaitingField) {
    if (currentAwaitingField !== 'slot') return false;

    const positivePatterns = [
        /\bsim\b/i,
        /\bok\b/i,
        /\baceito\b/i,
        /\bpode\b/i,
        /\bclaro\b/i,
        /\bvamos\b/i,
        /\btop\b/i,
        /\bshow\b/i,
        /\bbeleza\b/i,
        /\bcombinado\b/i,
        /\bpor favor\b/i,
        /\bpf\b/i,
        /\bpfv\b/i
    ];

    const messageLower = message?.toLowerCase() || '';
    const isConfirmation = positivePatterns.some(pattern => pattern.test(messageLower));

    logDebug('POSITIVE_CONFIRMATION_CHECK', {
        currentAwaitingField,
        message: message?.substring(0, 30),
        isConfirmation
    });

    return isConfirmation;
}

// ============================================================================
// 🔄 IMPLEMENTAÇÃO: CONTINUE COLLECTION
// ============================================================================
function continueCollection(memory, chatContext = null, message = null, flags = {}) {
    const currentAwaitingField = chatContext?.lastExtractedInfo?.awaitingField;

    // Verificar se temos todos os dados necessários
    const hasTherapy = !!memory?.therapyArea;
    const hasComplaint = !!(memory?.complaint || memory?.primaryComplaint);
    const hasAge = !!(memory?.patientAge || memory?.patientInfo?.age);
    const hasPeriod = !!(memory?.preferredPeriod || memory?.pendingPreferredPeriod || memory?.period);
    const hasAllData = hasComplaint && hasTherapy && hasAge && hasPeriod;

    logDebug('CONTINUE_COLLECTION_START', {
        hasTherapy,
        hasComplaint,
        hasAge,
        hasPeriod,
        hasAllData,
        currentAwaitingField,
        message: message?.substring(0, 30)
    });

    // 🔥 CORREÇÃO: Se estamos oferecendo orçamento e o usuário confirmou, explicar valores
    if (currentAwaitingField === 'budget_offer' && isPositiveConfirmation(message, 'budget_offer')) {
        const therapies = memory?.allDetectedTherapies || [];
        const therapyCount = therapies.length;

        logDecision('CONTINUE_COLLECTION_BUDGET_CONFIRMED', { therapyCount });

        // Se tem múltiplas terapias, explicar que são particulares e oferecer valores
        if (therapyCount > 1) {
            return {
                action: 'smart_response',
                handler: 'leadQualificationHandler',
                text: "Somos particulares, mas oferecemos valores especiais para pacientes que fazem acompanhamento multidisciplinar 💚 Posso te passar os valores das avaliações?",
                extractedInfo: {
                    awaitingField: 'price_info',
                    multipleTherapies: true
                }
            };
        }
    }

    // 🔥 F4: SEAMLESS HANDOVER - Quando tem todos os dados e usuário quer agendar
    const bookingIntent = detectBookingIntent(message);
    if (hasAllData && (isPositiveConfirmation(message, 'slot') || bookingIntent)) {
        logDecision('F4_SEAMLESS_HANDOVER', { 
            action: 'show_slots', 
            reason: bookingIntent ? 'booking_intent_detected' : 'positive_confirmation',
            hasAllData 
        });
        return {
            action: 'show_slots',
            handler: 'leadQualificationHandler',
            text: "Perfeito! Vou conferir as vagas para você... 💚",
            extractedInfo: {
                awaitingField: 'slot_confirmation',
                slotRequested: true,
                seamlessHandover: true
            }
        };
    }

    const hasAnyData = !!(memory?.therapyArea || memory?.complaint || memory?.patientAge || memory?.lastHandler);
    
    // 🆕 F6: Emotional Support
    const emotionalSupport = getEmotionalSupport(memory, flags);
    
    const acolhimento = !hasAnyData
        ? "Oi! 😊 Que bom que você entrou em contato! Seja bem-vindo(a) à Clínica Fono Inova 💚 "
        : emotionalSupport || "";

    // 🆕 F5: Smart Repetition - verificar se já respondeu antes de perguntar
    const followUpResult = getSmartFollowUp(memory, false, chatContext);
    
    // ✅ CORREÇÃO CRÍTICA: Se getSmartFollowUp retornou action específica (ex: show_slots), respeitar
    if (followUpResult?.action === 'show_slots') {
        logDecision('CONTINUE_COLLECTION_SHOW_SLOTS', { reason: 'has_all_data', action: followUpResult.action });
        return {
            action: 'show_slots',
            handler: 'leadQualificationHandler',
            text: followUpResult.text || "Perfeito! Vou conferir as vagas para você... 💚",
            extractedInfo: {
                awaitingField: 'slot_selection',
                hasAllData: true,
                reason: 'all_fields_collected'
            }
        };
    }
    
    const followUpText = typeof followUpResult === 'string' ? followUpResult : followUpResult.text;
    const awaitingField = typeof followUpResult === 'object' ? followUpResult.awaitingField : null;
    
    // Verificar se devemos pular a pergunta (F5)
    if (awaitingField && message) {
        const skipCheck = shouldSkipQuestion(awaitingField, message, memory, chatContext);
        if (skipCheck.skip && skipCheck.extracted) {
            logDecision('F5_SKIP_QUESTION', { field: awaitingField, extracted: skipCheck.extracted });
            // Retorna para processar o dado extraído
            return {
                action: 'continue_collection',
                handler: 'leadQualificationHandler',
                text: `${acolhimento}Perfeito! 💚`,
                extractedInfo: {
                    [awaitingField]: skipCheck.extracted,
                    awaitingField: null,
                    smartSkip: true
                }
            };
        }
    }

    logDebug('CONTINUE_COLLECTION_FOLLOWUP', { awaitingField, hasAcolhimento: !!acolhimento, hasEmotionalSupport: !!emotionalSupport });

    const result = {
        action: 'continue_collection',
        handler: 'leadQualificationHandler',
        text: followUpText ? `${acolhimento}${followUpText} 💚` : `${acolhimento}Como posso te ajudar? 💚`,
        extractedInfo: awaitingField ? { awaitingField } : {}
    };

    logDecision('CONTINUE_COLLECTION_RESULT', { awaitingField, textLength: result.text.length });
    return result;
}

// ============================================================================
// 🔄 F5: SMART REPETITION - Evitar perguntar algo que já foi respondido
// ============================================================================
function shouldSkipQuestion(field, message, memory, chatContext) {
    if (!message) return false;
    
    const msgLower = message.toLowerCase().trim();
    
    // Se já perguntamos isso antes e o usuário respondeu algo
    const askedBefore = (memory?.askedQuestions || []).some(q => q.field === field);
    const lastInteraction = memory?.lastInteraction;
    const hoursSinceLastAsk = lastInteraction ? (Date.now() - new Date(lastInteraction)) / (1000 * 60 * 60) : 999;
    
    // Se perguntou nas últimas 2 horas e usuário respondeu com algo que parece válido
    if (askedBefore && hoursSinceLastAsk < 2) {
        // Tentar extrair do contexto
        switch (field) {
            case 'age':
                // Se a mensagem tem números que parecem idade
                if (/\b\d{1,2}\s*(anos?|aninhos?|a)\b/i.test(msgLower)) {
                    logDebug('F5_SMART_SKIP', { field, reason: 'age_mentioned_in_message' });
                    return { skip: true, extracted: extractAgeFromText(msgLower) };
                }
                break;
            case 'therapy':
                // Se detectou terapia na mensagem
                const therapies = ['fono', 'psico', 'to', 'fisio', 'neuro', 'musicoterapia'];
                if (therapies.some(t => msgLower.includes(t))) {
                    logDebug('F5_SMART_SKIP', { field, reason: 'therapy_mentioned_in_message' });
                    return { skip: true };
                }
                break;
            case 'period':
                // Se mencionou período
                if (/\b(manh[ãa]|tarde|noite|manhazinha|tardinha)\b/i.test(msgLower)) {
                    logDebug('F5_SMART_SKIP', { field, reason: 'period_mentioned_in_message' });
                    return { skip: true, extracted: extractPeriodFromText(msgLower) };
                }
                break;
        }
    }
    
    return { skip: false };
}

function extractAgeFromText(text) {
    const match = text.match(/\b(\d{1,2})\s*(anos?|aninhos?|a)\b/i);
    return match ? parseInt(match[1], 10) : null;
}

function extractPeriodFromText(text) {
    if (/manh[ãa]/i.test(text)) return 'manhã';
    if (/tarde/i.test(text)) return 'tarde';
    if (/noite/i.test(text)) return 'noite';
    return null;
}

// ============================================================================
// 💚 F6: EMOTIONAL INTELLIGENCE - Acolhimento contextual
// ============================================================================
function getEmotionalSupport(memory, flags = {}) {
    const patientAge = memory?.patientAge || memory?.patientInfo?.age;
    const complaint = memory?.complaint || memory?.primaryComplaint;
    const therapy = memory?.therapyArea;
    
    // Detectar sinais de estresse
    const stressSignals = flags?.userExpressedPain || flags?.mentionsWorry || flags?.mentionsUrgency;
    
    if (!stressSignals) return null;
    
    let support = '';
    
    // Acolhimento por idade
    if (patientAge && patientAge <= 2) {
        support = "Sei que lidar com um bebê pode ser desafiador. Você está fazendo o melhor 💚 ";
    } else if (patientAge && patientAge <= 5) {
        support = "Entendo que essa fase traz muitas dúvidas. Estou aqui pra ajudar vocês 💚 ";
    }
    
    // Acolhimento por queixa
    if (complaint?.includes('tea') || complaint?.includes('autismo')) {
        support += "Cada criança com TEA é única, e o diagnóstico precoce faz toda diferença. ";
    } else if (complaint?.includes('tdah')) {
        support += "O TDAH é desafiador, mas com o suporte certo a criança desenvolve todo potencial. ";
    }
    
    return support || null;
}

// ============================================================================
// 🔍 DETECT BOOKING INTENT (F4: Seamless Handover)
// ============================================================================
function detectBookingIntent(message) {
    if (!message) return false;
    
    const bookingPatterns = [
        /\b(quero\s+agendar|vamos\s+agendar|pode\s+agendar|marca)\b/i,
        /\b(quero\s+marcar|vamos\s+marcar|pode\s+marcar)\b/i,
        /\b(tem\s+vaga|tem\s+hor[áa]rio|quando\s+tem)\b/i,
        /\b(pode\s+ver|pode\s+conferir)\s+(vaga|hor[áa]rio)/i,
        /\b(show|bora|vamos\s+nessa)\b/i
    ];
    
    const messageLower = message.toLowerCase();
    return bookingPatterns.some(pattern => pattern.test(messageLower));
}

// ============================================================================
// 🧠 BUILD CONTEXT FOR AI (Nada engessado! Passa contexto, IA responde)
// ============================================================================
function buildContextForAI(questionType, memory, analysis) {
    const context = {
        questionType,
        therapyArea: memory?.therapyArea || analysis?.therapyArea,
        patientAge: memory?.patientAge || memory?.patientInfo?.age,
        patientName: memory?.patientName || memory?.patientInfo?.name,
        complaint: memory?.complaint || memory?.primaryComplaint,
        emotionalContext: memory?.emotionalContext || {},
        hasMultipleChildren: memory?.offerMultiChildDiscount,
        isPostEvaluation: memory?.isPostEvaluation,
        specificTime: memory?.timeContext,
        requiresEmpathy: memory?.requiresEmpathy,
        pricingInfo: null
    };
    
    // Adiciona info de preço se necessário
    if (questionType === 'price') {
        import('../../config/pricing.js').then(({ getTherapyPricing }) => {
            context.pricingInfo = getTherapyPricing(context.therapyArea);
        });
    }
    
    // Adiciona info de convênio/laudo se necessário
    if (questionType === 'plans') {
        context.hasLaudo = context.therapyArea === 'neuropsicologia' || context.therapyArea === 'neuropsi';
        context.reembolsoInfo = true;
    }
    
    // Retorna contexto para IA usar (não resposta engessada!)
    return JSON.stringify(context);
}

// ============================================================================
// 💰 BUILD PRICE ANSWER: Valor do Trabalho → Urgência → Preço
// ============================================================================
function buildPriceAnswer(memory, analysis) {
    // Usa analysis se memory não tiver os dados (dados da mensagem atual)
    const therapy = memory?.therapyArea || analysis?.therapyArea;
    const age = memory?.patientAge || memory?.patientInfo?.age || analysis?.extractedInfo?.idade;

    // 1️⃣ VALOR DO TRABALHO (explicar o que vai receber)
    let valor = "";
    switch (therapy?.toLowerCase()) {
        case 'fonoaudiologia':
        case 'fono':
            valor = "A avaliação fonoaudiológica mapeia exatamente onde seu filho precisa de estímulo — vocês saem com um plano personalizado pro desenvolvimento da fala.";
            break;
        case 'psicologia':
        case 'psico':
            valor = "A avaliação psicológica entende o que está por trás do comportamento e dá um direcionamento claro pra família — vocês saem com orientações práticas.";
            break;
        case 'neuropsicologia':
        case 'neuropsi':
            valor = "A avaliação neuropsicológica é completa: mapeamos atenção, memória, raciocínio e comportamento. Vocês recebem um laudo detalhado que serve pra escola, médicos e tratamentos.";
            break;
        case 'terapia_ocupacional':
        case 'to':
            valor = "A avaliação de TO identifica as dificuldades sensoriais e de coordenação, e monta um plano pra ele ganhar mais autonomia no dia a dia.";
            break;
        case 'fisioterapia':
        case 'fisio':
            valor = "A avaliação de fisioterapia analisa postura, equilíbrio e coordenação motora — saímos com um plano específico pro desenvolvimento.";
            break;
        default:
            valor = "A avaliação é completa e personalizada — vocês saem com um plano claro do que fazer.";
    }

    // 2️⃣ URGÊNCIA CONTEXTUAL (se tiver idade)
    let urgencia = "";
    if (age) {
        const ageNum = parseInt(age, 10);
        if (!isNaN(ageNum)) {
            if (ageNum <= 6) {
                urgencia = "Nessa fase, cada mês faz diferença pro desenvolvimento!";
            } else if (ageNum <= 12) {
                urgencia = "É uma fase importante pra não deixar acumular dificuldades.";
            } else if (ageNum <= 17) {
                urgencia = "Esse momento é chave pra recuperar o ritmo.";
            }
        }
    }

    // 3️⃣ PREÇO (usando pricing centralizado)
    const preco = getInvestmentText(therapy);

    // Montar resposta completa (sem acolhimento - fica no smartResponse)
    const partes = [valor, urgencia, preco].filter(p => p);
    return partes.join(' ');
}

// ============================================================================
// 🏥 INSURANCE BRIDGE: Terapia ≠ Convênio, mas complementar
// ============================================================================
function buildInsuranceBridgeAnswer(memory) {
    const therapy = memory?.therapyArea;
    const hasLaudo = therapy === 'neuropsicologia' || therapy === 'neuropsi';
    
    // 1️⃣ Reconhecer e ser transparente
    let response = "Somos particulares 💚 ";
    
    // 2️⃣ Explicar POR QUE (terapia não é coberta)
    response += "Terapia não entra no rol obrigatório dos convênios — infelizmente é uma limitação do sistema de saúde, não da clínica. ";
    
    // 3️⃣ O BRIDGE: Laudo/relatório serve para reembolso
    if (hasLaudo) {
        response += "O laudo da neuropsicologia é aceito pela maioria dos convênios para reembolso parcial (geralmente 40-60%). ";
    } else {
        response += "Emitimos relatórios técnicos que muitos convênios aceitam para reembolso parcial. ";
    }
    
    // 4️⃣ Benefícios do particular + chamada para ação
    response += "Por sermos particulares, você tem agendamento imediato, horários flexíveis e equipe especializada. ";
    
    return response;
}

// ============================================================================
// 📅 BUILD SCHEDULE ANSWER: Contextualiza horários
// ============================================================================
function buildScheduleAnswer(memory) {
    const specificTime = memory?.emotionalContext?.specificTimeRequest;
    
    let response = "Atendemos de segunda a sexta, das 8h às 18h. ";
    
    // Contextualiza se pediu horário específico cedo
    if (specificTime && specificTime < 9) {
        response += `O horário das ${specificTime}h é pensado justamente pra não atrapalhar sua rotina de trabalho! 💚 `;
    }
    
    // Informa sobre horários personalizados para horários especiais
    if (specificTime && (specificTime < 8 || specificTime >= 17)) {
        response += "Para horários personalizados (antes das 8h, após as 17h ou fins de semana), nossa equipe entra em contato diretamente para encontrar a melhor solução. Posso registrar seu interesse? 💚";
    }
    
    return response;
}

// ============================================================================
// 🎯 GET SMART FOLLOW UP (Retoma naturalmente baseado no que falta)
// ============================================================================
function getSmartFollowUp(memory, needsTherapySelection = false, chatContext = null) {
    // 🐛 DEBUG: Verificar flags do chatContext para estado pendente
    const awaitingComplaint = chatContext?.lastExtractedInfo?.awaitingComplaint || memory?.awaitingComplaint;
    const awaitingAge = chatContext?.lastExtractedInfo?.awaitingAge || memory?.awaitingAge;
    const awaitingPeriod = chatContext?.lastExtractedInfo?.awaitingPeriod || memory?.awaitingPeriod;

    // 🔥 CORREÇÃO: Verificar também o awaitingField do contexto atual
    const currentAwaitingField = chatContext?.lastExtractedInfo?.awaitingField;

    const hasTherapy = !!memory?.therapyArea;
    const hasComplaint = !!(memory?.complaint || memory?.primaryComplaint);
    const hasAge = !!(memory?.patientAge || memory?.patientInfo?.age || memory?.age);
    // 🔥 CORREÇÃO: Se o contexto está esperando 'period', significa que ainda não temos
    // Mas se o usuário acabou de responder o período, devemos considerar que temos
    const hasPeriod = !!(memory?.preferredPeriod || memory?.pendingPreferredPeriod || memory?.period) ||
        (currentAwaitingField === 'period' && memory?.period);
    const hasMultipleTherapies = memory?.hasMultipleTherapies || memory?.allDetectedTherapies?.length > 1;

    // 🆕 F1: CONTEXTUAL MEMORY - Rastrear o que já foi perguntado
    const askedQuestions = memory?.askedQuestions || [];
    const lastQuestion = askedQuestions[askedQuestions.length - 1];
    const askCount = {
        complaint: askedQuestions.filter(q => q.field === 'complaint').length,
        therapy: askedQuestions.filter(q => q.field === 'therapy').length,
        age: askedQuestions.filter(q => q.field === 'age').length,
        period: askedQuestions.filter(q => q.field === 'period').length,
    };

    logDebug('GET_SMART_FOLLOWUP_STATE', {
        hasComplaint, hasTherapy, hasAge, hasPeriod,
        awaitingComplaint: !!awaitingComplaint,
        awaitingAge: !!awaitingAge,
        awaitingPeriod: !!awaitingPeriod,
        currentAwaitingField,
        hasMultipleTherapies,
        askCount,
        lastQuestion: lastQuestion?.field
    });

    // 🔥 ORDEM CORRETA: Queixa → Terapia → Idade → Período
    // 🔧 NOTA: Acolhimento é adicionado pelo smartResponse/continueCollection, não aqui

    // 🐛 DEBUG: Se estamos esperando uma queixa especificamente, retornar awaitingField
    if (awaitingComplaint && !hasComplaint) {
        logDecision('FOLLOWUP_COMPLAINT_FROM_FLAG', { reason: 'awaitingComplaint_flag' });
        return {
            text: buildAskQuestion('complaint', askCount.complaint, memory),
            awaitingField: 'complaint'
        };
    }

    // 🔧 CORREÇÃO: Primeira coisa é entender a queixa
    if (!hasComplaint) {
        logDecision('FOLLOWUP_COMPLAINT', { reason: 'no_complaint', timesAsked: askCount.complaint });
        return {
            text: buildAskQuestion('complaint', askCount.complaint, memory),
            awaitingField: 'complaint'
        };
    }

    // Se tem queixa mas não tem terapia definida → perguntar especialidade
    // 🔥 NOTA: Se hasMultipleTherapies=true, a IA já tem esse contexto e vai acolher apropriadamente
    if (!hasTherapy && hasComplaint) {
        logDecision('FOLLOWUP_THERAPY', { reason: 'has_complaint_no_therapy', hasMultipleTherapies, timesAsked: askCount.therapy });
        return {
            text: buildAskQuestion('therapy', askCount.therapy, memory),
            awaitingField: 'therapy'
        };
    }

    // SÓ DEPOIS de ter queixa E terapia definida → perguntar idade
    if (!hasAge && hasComplaint) {
        logDecision('FOLLOWUP_AGE', { reason: 'has_complaint_no_age', timesAsked: askCount.age });
        return {
            text: buildAskQuestion('age', askCount.age, memory),
            awaitingField: 'age'
        };
    }

    // SÓ DEPOIS de ter idade → perguntar período
    if (!hasPeriod && hasAge) {
        logDecision('FOLLOWUP_PERIOD', { reason: 'has_age_no_period', timesAsked: askCount.period });
        return {
            text: buildAskQuestion('period', askCount.period, memory),
            awaitingField: 'period'
        };
    }

    // Tem tudo → oferece slots
    logDecision('FOLLOWUP_SLOTS', { reason: 'has_all_data' });
    return {
        action: 'show_slots',
        text: null,  // Handler vai buscar slots reais
        awaitingField: 'slot_selection'
    };
}

// ============================================================================
// 🆕 F1: CONTEXTUAL MEMORY - Evitar repetição de perguntas
// ============================================================================
function buildAskQuestion(field, timesAsked, memory) {
    const patientName = memory?.patientName || memory?.patientInfo?.name;
    const nameRef = patientName ? `${patientName.split(' ')[0]}` : 'a criança';
    
    // Primeira vez: pergunta normal
    // Segunda vez: variação
    // Terceira+ vez: abordagem diferente
    
    const variations = {
        complaint: {
            0: `Me conta o que está acontecendo com ${nameRef}? 💚`,
            1: `O que vocês estão percebendo com ${nameRef}? 💚`,
            2: `Me conta um pouco da situação de vocês 💚`
        },
        therapy: {
            0: `É pra qual área você está procurando? 💚`,
            1: `Você acha que seria fono, psicologia, ou outra área? 💚`,
            2: `Tem alguma área em mente? 💚`
        },
        age: {
            0: `Quantos aninhos ele tem? 💚`,
            1: `E a idade, quantos aninhos? 💚`,
            2: `Tem quantos anos? 💚`
        },
        period: {
            0: `Que horário costuma ser melhor pra vocês? 💚`,
            1: `Funciona melhor de manhã ou à tarde? 💚`,
            2: `Qual período encaixa melhor na rotina de vocês? 💚`
        }
    };
    
    // Limita ao máximo de variações disponíveis
    const maxVariations = Object.keys(variations[field] || {}).length;
    const variationIndex = Math.min(timesAsked, maxVariations - 1);
    
    return variations[field]?.[variationIndex] || variations[field]?.[0];
}

// ============================================================================
// 🔍 DETECT DIRECT QUESTION
// ============================================================================
function detectDirectQuestion(flags = {}) {
    const detected =
        flags.asksPrice || flags.asksAboutPrice || flags.insistsPrice ? 'price' :
            flags.asksAddress || flags.asksLocation ? 'address' :
                flags.asksPlans || flags.mentionsInsurance || flags.asksInsurance ? 'plans' :
                    flags.asksSchedule || flags.asksDays || flags.asksTimes || flags.wantsSchedule ? 'schedule' :
                        flags.asksSpecialtyAvailability || flags.asksTherapyInfo ? 'specialty' :
                            null;

    if (detected) {
        logDebug('DIRECT_QUESTION_DETECTED', { questionType: detected, flags: Object.keys(flags).filter(k => flags[k]) });
    }

    return detected;
}

// ============================================================================
// 📝 EXTRACT FROM FLAGS
// ============================================================================
function extractFromFlags(flags) {
    const extracted = {};

    if (flags.ageGroup) extracted.ageGroup = flags.ageGroup;
    if (flags.topic) extracted.topic = flags.topic;
    if (flags.therapyArea) extracted.therapyArea = flags.therapyArea;

    return extracted;
}

// ============================================================================
// 💚 IMPLEMENTAÇÃO: HANDLE WARM LEAD (Lead morno - vai pensar/decidir)
// ============================================================================
async function handleWarmLead(blockType, lead, memory, chatContext) {
    logDebug('HANDLE_WARM_LEAD_START', { 
        blockType: blockType.type, 
        leadId: lead?._id?.toString(),
        emoji: blockType.emoji 
    });

    // 1. Gera mensagem de encerramento ACOLHEDORA (nunca "Disponha")
    const closeMessage = generateWarmCloseMessage(blockType.type, lead?.name);
    
    // 2. Agenda follow-up usando o ORQUESTRADOR EXISTENTE (legado)
    let scheduled = false;
    let followupId = null;
    
    if (lead?._id) {
        try {
            // Usa o followupOrchestrator existente (já tem IA, timing ótimo, etc)
            const result = await createSmartFollowupForLead(lead._id, {
                objective: `warm_lead_${blockType.type}`, // ex: warm_lead_consultar_familia
                attempt: 1
            });
            scheduled = true;
            followupId = result.followup?._id;
            
            logger.info('FOLLOWUP_SCHEDULED_VIA_ORCHESTRATOR', {
                leadId: lead._id,
                followupId,
                blockType: blockType.type
            });
        } catch (err) {
            logger.error('ERROR_SCHEDULING_FOLLOWUP', { 
                leadId: lead._id, 
                error: err.message 
            });
        }
    }

    const result = {
        action: 'warm_lead_close',
        handler: 'leadQualificationHandler',
        text: closeMessage,
        extractedInfo: {
            blockType: blockType.type,
            followupScheduled: scheduled,
            followupId,
            delayHours: blockType.delayHours,
            awaitingField: null // Encerra o fluxo atual
        }
    };

    logDecision('WARM_LEAD_CLOSE_RESULT', {
        blockType: blockType.type,
        scheduled,
        textLength: result.text.length
    });

    return result;
}

/**
 * 💬 Gera mensagem de encerramento ACOLHEDORA (nunca "Disponha")
 */
function generateWarmCloseMessage(blockType, leadName = '') {
    const name = leadName ? leadName.split(' ')[0] : '';
    const nameRef = name ? `, ${name}` : '';

    const messages = {
        consultar_familia: [
            `Claro${nameRef}! 💑 É super importante vocês decidirem juntos. Vou ficar por aqui, qualquer dúvida que surgir é só chamar!`,
            `Entendi${nameRef}! 💚 Conversar em família é essencial. Fico no aguardo do retorno de vocês!`,
            `Perfeito${nameRef}! 💑 Decisão importante assim tem que ser em conjunto. Estou à disposição quando precisarem!`
        ],
        vai_pensar: [
            `Sem problema${nameRef}! 🤔 Decisão importante pede reflexão. Vou te mandar uma mensagenzinha em alguns dias só pra saber como você tá, tudo bem? 💚`,
            `Tudo bem${nameRef}! 💚 Pensa com calma. Daqui a pouco eu volto só pra ver se conseguiu decidir — sem pressão! 😊`,
            `Claro${nameRef}! 🤔 Pensa direitinho. Qualquer coisa que precisar pra tomar essa decisão, é só me chamar, tá? 💚`
        ],
        verificar_plano: [
            `Entendo${nameRef}! 🏥 Verifica com o plano e me avisa. Enquanto isso, fica sabendo que muitas famílias estão fazendo particular e pedindo reembolso — funciona super bem! 💚`,
            `Ok${nameRef}! 💚 Dá uma olhada lá. Se precisar de qualquer documentação específica pro reembolso, é só me pedir que eu preparo tudo certinho!`,
            `Combinado${nameRef}! 🏥 Vê com o plano e qualquer coisa me fala. Estou por aqui! 💚`
        ],
        organizar_agenda: [
            `Entendo perfeitamente${nameRef}! 📅 Rotina de quem trabalha é corrida mesmo. Vou te dar um tempinho pra organizar e volto a falar contigo, tá bom? 💚`,
            `Sem problema${nameRef}! 💚 Organizar a agenda é importante. Daqui uns dias eu apareço só pra saber se conseguiu encaixar — sem pressa! 😊`,
            `Claro${nameRef}! 📅 Dá uma olhada na sua semana. Qualquer dúvida sobre horários flexíveis, é só chamar! 💚`
        ],
        comparar_precos: [
            `Tudo bem${nameRef}! 💰 Compara com calma. Só te lembro que o diferencial daqui é o acolhimento e a equipe integrada — isso faz toda diferença no resultado. Depois me conta! 💚`,
            `Ok${nameRef}! 💚 Pesquisa direitinho. Se quiser, posso te explicar o que está incluído na avaliação — às vezes comparar só o preço não conta a história toda! 😊`,
            `Sem problema${nameRef}! 💰 Valor é importante mesmo. Se tiver alguma dúvida sobre o que a gente oferece, estou aqui pra esclarecer! 💚`
        ],
        nao_agora: [
            `Claro${nameRef}! ⏰ Quando você estiver pronta, é só chamar. Vou ficar por aqui! 💚`,
            `Tudo bem${nameRef}! 💚 Não tem pressa. Quando fizer sentido pra você, estou à disposição! 😊`,
            `Ok${nameRef}! ⏰ A porta está aberta. Qualquer hora que você quiser retomar, é só me chamar! 💚`
        ]
    };

    const options = messages[blockType] || messages.vai_pensar;
    
    // Variação baseada no horário
    const hour = new Date().getHours();
    const index = hour % options.length;
    
    return options[index];
}

/**
 * 🕵️ Detecta se o lead está "morno" (vai pensar/decidir depois)
 */
function detectWarmLead(text, context = {}) {
    const textLower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    const patterns = [
        {
            type: 'consultar_familia',
            regex: /vou\s+(falar|conversar|consultar)\s+(com\s+)?(meu\s+marido|minha\s+esposa|meu\s+esposo|minha\s+mulher|meus\s+pais|minha\s+mae|meu\s+pai|familia)/i,
            delayHours: 48,
            priority: 'high'
        },
        {
            type: 'vai_pensar',
            regex: /(vou\s+pensar|vou\s+ver|vou\s+avaliar|depois\s+(eu\s+)?respondo|logo\s+(eu\s+)?marco|logo\s+eu\s+(vejo|decido))/i,
            delayHours: 72,
            priority: 'medium'
        },
        {
            type: 'verificar_plano',
            regex: /(vou\s+ver\s+(com\s+)?(o\s+)?plano|vou\s+checar\s+(o\s+)?convenio|vou\s+ver\s+com\s+a\s+unimed)/i,
            delayHours: 48,
            priority: 'high'
        },
        {
            type: 'organizar_agenda',
            regex: /(vou\s+ver\s+(minha\s+)?agenda|vou\s+organizar|rotina\s+corrida|agenda\s+cheia|nao\s+tenho\s+tempo)/i,
            delayHours: 96,
            priority: 'low'
        },
        {
            type: 'comparar_precos',
            regex: /(vou\s+ver\s+(os\s+)?valores|vou\s+comparar|outras\s+clinicas|vou\s+pesquisar)/i,
            delayHours: 48,
            priority: 'high'
        },
        {
            type: 'nao_agora',
            regex: /(nao\s+(e\s+)?agora|depois\s+(eu\s+)?entro\s+em\s+contato|mais\s+tarde|outra\s+hora)/i,
            delayHours: 72,
            priority: 'medium'
        }
    ];

    for (const pattern of patterns) {
        if (pattern.regex.test(textLower)) {
            logger.info('WARM_LEAD_DETECTED', { type: pattern.type, text: text.slice(0, 50) });
            return pattern;
        }
    }

    return null;
}

// ============================================================================
// 🎯 DETECTORES DE CONTEXTO PARA IA (Nada engessado!)
// ============================================================================

/**
 * 🎭 Detecta contexto emocional para IA acolher naturalmente
 */
function detectEmotionalContext(text, memory, flags) {
    const textLower = (text || '').toLowerCase();
    const context = {
        expressedFrustration: false,
        expressedUrgency: false,
        multipleChildren: false,
        postEvaluation: false,
        cancellation: false,
        familyConsultation: false,
        specificTimeRequest: null
    };
    
    // Frustração (????, demora, etc)
    if (/\?{2,}|(demora|atraso|sumiu|nao responde)/i.test(textLower) || 
        flags?.expressedFrustration) {
        context.expressedFrustration = true;
    }
    
    // Urgência explícita
    if (/(urgente|preciso logo|quanto antes|nao aguento mais)/i.test(textLower)) {
        context.expressedUrgency = true;
    }
    
    // Múltiplas crianças
    if (/(dois filhos|duas criancas|gemeos|irmaos|as duas|os dois)/i.test(textLower) ||
        flags?.hasMultipleChildren) {
        context.multipleChildren = true;
    }
    
    // Pós-avaliação
    if (/(fiz a avaliacao|fizemos a avaliacao|avaliacao feita|ja foi avaliado)/i.test(textLower) ||
        memory?.hadEvaluation) {
        context.postEvaluation = true;
    }
    
    // Cancelamento
    if (/(cancelar|desistir|nao vou conseguir ir|imprevisto)/i.test(textLower) ||
        flags?.isCancellation) {
        context.cancellation = true;
    }
    
    // Consultar família (padrão específico)
    if (/(falar com (meu|minha)|consultar (marido|esposa)|decidir juntos)/i.test(textLower)) {
        context.familyConsultation = true;
    }
    
    // Horário específico mencionado
    const timeMatch = textLower.match(/(\d{1,2})\s*h/);
    if (timeMatch) {
        context.specificTimeRequest = parseInt(timeMatch[1], 10);
    }
    
    return context;
}

/**
 * 📝 Enriquece memory com contexto para IA responder naturalmente
 */
function enrichContextForAI(memory, flags, emotionalContext) {
    const enriched = { ...memory };
    
    // Adiciona flags de contexto emocional
    enriched.emotionalContext = emotionalContext;
    
    // Marca se deve contextualizar horário
    if (emotionalContext.specificTimeRequest && emotionalContext.specificTimeRequest < 9) {
        enriched.shouldContextualizeTime = true;
        enriched.timeContext = 'early_morning';
    }
    
    // Marca se deve oferecer desconto multi-criança
    if (emotionalContext.multipleChildren) {
        enriched.offerMultiChildDiscount = true;
    }
    
    // Marca se deve acolher frustração
    if (emotionalContext.expressedFrustration) {
        enriched.requiresEmpathy = true;
    }
    
    // Marca contexto pós-avaliação
    if (emotionalContext.postEvaluation) {
        enriched.isPostEvaluation = true;
    }
    
    return enriched;
}

// ============================================================================
// 🔗 EXPORTAÇÃO: Manter compatibilidade com código existente
// ============================================================================

/**
 * Wrapper para compatibilidade com chamadas antigas
 */
export async function decisionEngine(params) {
    // Mapear parâmetros antigos para novo formato
    const { analysis, memory, flags, lead, contextPack, message, chatContext, missing } = params;

    return decide({
        analysis,
        memory,
        flags: flags || analysis?.flags,
        lead,
        contextPack,
        message,
        missing,      // 🆕 FIX BUG 2: chatContext e missing não estavam sendo passados
        chatContext    // 🆕 Isso quebrava F5 Smart Repetition e getSmartFollowUp
    });
}

// Exportar funções auxiliares para testes (decide já exportado acima)
export {
    warmRecall,
    acknowledgePain,
    smartResponse,
    continueCollection,
    buildPriceAnswer,
    getSmartFollowUp,
    handleWarmLead,
    detectWarmLead,
    generateWarmCloseMessage,
    buildAskQuestion,
    shouldSkipQuestion,
    getEmotionalSupport,
    detectBookingIntent
};
