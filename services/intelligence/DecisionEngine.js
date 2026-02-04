/**
 * 🧠 DecisionEngine - Versão 3.0 (Arquitetura Respond+Resume)
 * 
 * FILOSOFIA: NUNCA ignore o usuário. SEMPRE responda primeiro, depois retome.
 * Não há árvore linear. Há prioridades dinâmicas baseadas no contexto.
 */

import { generateWarmRecall } from './ContextPack.js';
import Logger from '../utils/Logger.js';

const logger = new Logger('DecisionEngine');

// 🔧 Helper para logs estruturados
function logDecision(step, data) {
    logger.info(`[DECISION_FLOW] ${step}`, data);
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
    // PRIORIDADE 1: ACOLHIMENTO EMOCIONAL (Primeira vez que expressa dor)
    // ============================================================================
    const expressedPain = flags?.userExpressedPain || flags?.hasPain;
    const painAcknowledged = memory?.painAcknowledged || lead?.qualificationData?.painAcknowledged;

    if (expressedPain && !painAcknowledged) {
        logDecision('PRIORITY_P1_ACKNOWLEDGE_PAIN', { expressedPain, painAcknowledged });
        return acknowledgePain(memory, chatContext);
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
        return smartResponse(directQuestion, flags, memory, analysis, inferredFromAnalysis, missing, chatContext);
    }

    // ============================================================================
    // PRIORIDADE 3: CONTINUE COLLECTION (Continuar coleta naturalmente)
    // ============================================================================
    logDecision('PRIORITY_P3_CONTINUE_COLLECTION', { memoryKeys: Object.keys(memory || {}) });
    // 🔥 MESCLA memory com analysis.extractedInfo para ter dados atualizados
    const enrichedMemory = {
        ...memory,
        ...(analysis?.extractedInfo?.complaint && { complaint: analysis.extractedInfo.complaint }),
        ...(analysis?.extractedInfo?.idade && { patientAge: analysis.extractedInfo.idade }),
        ...(analysis?.extractedInfo?.disponibilidade && { preferredPeriod: analysis.extractedInfo.disponibilidade }),
        ...(analysis?.therapyArea && { therapyArea: analysis.therapyArea }),
        // 🔥 CRÍTICO: Preservar dados de múltiplas terapias
        ...(memory?.hasMultipleTherapies && { hasMultipleTherapies: memory.hasMultipleTherapies }),
        ...(memory?.allDetectedTherapies && { allDetectedTherapies: memory.allDetectedTherapies })
    };
    return continueCollection(enrichedMemory, chatContext, message?.text);
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
    const followUp = getSmartFollowUp(memory, false, chatContext);
    
    logDebug('ACKNOWLEDGE_PAIN_FOLLOWUP', { followUpText: followUp?.substring(0, 50) });

    const result = {
        action: 'acknowledge_pain',
        handler: 'leadQualificationHandler',
        text: followUp ? `${acknowledgment} ${followUp} 💚` : `${acknowledgment} 💚`,
        extractedInfo: {
            painAcknowledged: true,
            emotionalSupportProvided: true
        }
    };
    
    logDecision('ACKNOWLEDGE_PAIN_RESULT', { action: result.action, textLength: result.text.length });
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
    switch (questionType) {
        case 'price':
            answer = buildPriceAnswer(memory, analysis);
            break;

        case 'address':
            answer = "Ficamos na Av. Minas Gerais, 405 - Bairro Jundiaí, Anápolis.";
            break;

        case 'plans':
            answer = "Somos particular, mas muitas famílias escolhem pelo atendimento imediato e equipe especializada.";
            break;

        case 'schedule':
            answer = "Atendemos de segunda a sexta, manhã e tarde.";
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
function continueCollection(memory, chatContext = null, message = null) {
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
    
    // 🔥 CORREÇÃO: Se temos todos os dados e o usuário confirmou com "Sim", mostrar horários
    // Isso evita repetir "Quer que eu veja os horários?" quando o usuário já disse "Sim"
    if (hasAllData && isPositiveConfirmation(message, 'slot')) {
        logDecision('CONTINUE_COLLECTION_CONFIRMATION', { action: 'show_slots', reason: 'has_all_data_and_confirmed' });
        return {
            action: 'show_slots',
            handler: 'leadQualificationHandler',
            text: "Perfeito! Vou conferir as vagas para você... 💚",
            extractedInfo: { 
                awaitingField: 'slot_confirmation',
                slotRequested: true
            }
        };
    }
    
    const hasAnyData = !!(memory?.therapyArea || memory?.complaint || memory?.patientAge || memory?.lastHandler);
    const acolhimento = !hasAnyData 
        ? "Oi! 😊 Que bom que você entrou em contato! Seja bem-vindo(a) à Clínica Fono Inova 💚 "
        : "";
    
    const followUpResult = getSmartFollowUp(memory, false, chatContext); // Usar chatContext para flags pendentes
    const followUpText = typeof followUpResult === 'string' ? followUpResult : followUpResult.text;
    const awaitingField = typeof followUpResult === 'object' ? followUpResult.awaitingField : null;
    
    logDebug('CONTINUE_COLLECTION_FOLLOWUP', { awaitingField, hasAcolhimento: !!acolhimento });

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

    // 3️⃣ PREÇO
    let preco = "";
    if (therapy?.includes('neuropsi') || therapy?.includes('neuropsicologia')) {
        preco = "O investimento é R$ 2.500 (em até 6x) ou R$ 2.300 à vista.";
    } else {
        preco = "O investimento na avaliação é R$ 220.";
    }

    // Montar resposta completa (sem acolhimento - fica no smartResponse)
    const partes = [valor, urgencia, preco].filter(p => p);
    return partes.join(' ');
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
    
    logDebug('GET_SMART_FOLLOWUP_STATE', {
        hasComplaint, hasTherapy, hasAge, hasPeriod,
        awaitingComplaint: !!awaitingComplaint,
        awaitingAge: !!awaitingAge,
        awaitingPeriod: !!awaitingPeriod,
        currentAwaitingField,
        hasMultipleTherapies
    });

    // 🔥 ORDEM CORRETA: Queixa → Terapia → Idade → Período
    // 🔧 NOTA: Acolhimento é adicionado pelo smartResponse/continueCollection, não aqui

    // 🐛 DEBUG: Se estamos esperando uma queixa especificamente, retornar awaitingField
    if (awaitingComplaint && !hasComplaint) {
        logDecision('FOLLOWUP_COMPLAINT_FROM_FLAG', { reason: 'awaitingComplaint_flag' });
        return {
            text: `Me conta um pouco: qual a situação que vocês estão vivendo? O que te preocupa? 💚`,
            awaitingField: 'complaint'
        };
    }

    // 🔧 CORREÇÃO: Primeira coisa é entender a queixa
    if (!hasComplaint) {
        logDecision('FOLLOWUP_COMPLAINT', { reason: 'no_complaint' });
        return {
            text: `Me conta um pouco: qual a situação que vocês estão vivendo? O que te preocupa? 💚`,
            awaitingField: 'complaint'
        };
    }

    // Se tem queixa mas não tem terapia definida → perguntar especialidade
    // 🔥 NOTA: Se hasMultipleTherapies=true, a IA já tem esse contexto e vai acolher apropriadamente
    if (!hasTherapy && hasComplaint) {
        logDecision('FOLLOWUP_THERAPY', { reason: 'has_complaint_no_therapy', hasMultipleTherapies });
        return {
            text: "Entendi 💚 É pra qual área você está procurando?",
            awaitingField: 'therapy'
        };
    }

    // SÓ DEPOIS de ter queixa E terapia definida → perguntar idade
    if (!hasAge && hasComplaint) {
        logDecision('FOLLOWUP_AGE', { reason: 'has_complaint_no_age' });
        return {
            text: "Qual a idade do paciente? 💚",
            awaitingField: 'age'
        };
    }

    // SÓ DEPOIS de ter idade → perguntar período
    if (!hasPeriod && hasAge) {
        logDecision('FOLLOWUP_PERIOD', { reason: 'has_age_no_period' });
        return {
            text: "Prefere manhã ou tarde? 💚",
            awaitingField: 'period'
        };
    }

    // Tem tudo → oferece slots
    logDecision('FOLLOWUP_SLOTS', { reason: 'has_all_data' });
    return {
        text: "Quer que eu veja os horários disponíveis? 💚",
        awaitingField: 'slot'
    };
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
// 🔗 EXPORTAÇÃO: Manter compatibilidade com código existente
// ============================================================================

/**
 * Wrapper para compatibilidade com chamadas antigas
 */
export async function decisionEngine(params) {
    // Mapear parâmetros antigos para novo formato
    const { analysis, memory, flags, lead, contextPack, message } = params;

    return decide({
        analysis,
        memory,
        flags: flags || analysis?.flags,
        lead,
        contextPack,
        message
    });
}

// Exportar funções auxiliares para testes (decide já exportado acima)
export {
    warmRecall,
    acknowledgePain,
    smartResponse,
    continueCollection,
    buildPriceAnswer,
    getSmartFollowUp
};
