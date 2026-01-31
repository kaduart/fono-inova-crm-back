/**
 * 🧠 DecisionEngine - Versão 3.0 (Arquitetura Respond+Resume)
 * 
 * FILOSOFIA: NUNCA ignore o usuário. SEMPRE responda primeiro, depois retome.
 * Não há árvore linear. Há prioridades dinâmicas baseadas no contexto.
 */

import { generateWarmRecall } from './ContextPack.js';

/**
 * 🔀 FUNÇÃO PRINCIPAL: decide()
 * 
 * Arquitetura de Prioridades:
 * P0: Warm Recall (lead retornando após 24h+)
 * P1: Acolhimento Emocional (expressou dor)
 * P2: Smart Response (pergunta direta: preço, endereço, etc)
 * P3: Continue Collection (continuar coleta do que falta)
 */
export async function decide({ analysis, memory, flags, lead, contextPack, message }) {

    console.log('[DecisionEngine] decide() INPUT:', {
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
        console.log('[DecisionEngine] P0: Warm Recall');
        return warmRecall(contextPack, memory, lead);
    }

    // ============================================================================
    // PRIORIDADE 1: ACOLHIMENTO EMOCIONAL (Primeira vez que expressa dor)
    // ============================================================================
    const expressedPain = flags?.userExpressedPain || flags?.hasPain;
    const painAcknowledged = memory?.painAcknowledged || lead?.qualificationData?.painAcknowledged;

    if (expressedPain && !painAcknowledged) {
        console.log('[DecisionEngine] P1: Acolhimento Emocional');
        return acknowledgePain(memory);
    }

    // ============================================================================
    // PRIORIDADE 2: SMART RESPONSE (Pergunta direta no meio do flow)
    // ============================================================================
    const directQuestion = detectDirectQuestion(flags);
    if (directQuestion) {
        console.log('[DecisionEngine] P2: Smart Response para', directQuestion);
        return smartResponse(directQuestion, flags, memory);
    }

    // ============================================================================
    // PRIORIDADE 3: CONTINUE COLLECTION (Continuar coleta naturalmente)
    // ============================================================================
    console.log('[DecisionEngine] P3: Continue Collection');
    return continueCollection(memory);
}

// ============================================================================
// 🎯 IMPLEMENTAÇÃO: WARM RECALL
// ============================================================================
function warmRecall(contextPack, memory, lead) {
    // Usa generateWarmRecall do ContextPack.js para mensagem personalizada
    const warmRecallText = generateWarmRecall(contextPack, lead);
    
    const hoursSince = contextPack?.lastDate 
        ? Math.round((Date.now() - new Date(contextPack.lastDate).getTime()) / (1000 * 60 * 60))
        : 0;

    return {
        action: 'warm_recall',
        handler: 'leadQualificationHandler',
        text: warmRecallText,
        extractedInfo: {
            returningLead: true,
            hoursSinceLastContact: hoursSince,
            warmRecallTier: hoursSince > 72 ? '72h' : hoursSince > 48 ? '48h' : '24h'
        }
    };
}

// ============================================================================
// 💚 IMPLEMENTAÇÃO: ACKNOWLEDGE PAIN
// ============================================================================
function acknowledgePain(memory) {
    const patientName = memory?.patientInfo?.name || memory?.patientName;
    const nameRef = patientName ? `${patientName.split(' ')[0]}` : 'seu filho';

    // Acolhe primeiro
    const acknowledgment = `Entendo sua preocupação 💚 Você fez muito bem em buscar orientação cedo — isso faz toda diferença pro desenvolvimento de ${nameRef}.`;

    // Retoma naturalmente baseado no que falta
    const followUp = getSmartFollowUp(memory);

    return {
        action: 'acknowledge_pain',
        handler: 'leadQualificationHandler',
        text: followUp ? `${acknowledgment} ${followUp} 💚` : `${acknowledgment} 💚`,
        extractedInfo: {
            painAcknowledged: true,
            emotionalSupportProvided: true
        }
    };
}

// ============================================================================
// 🧠 IMPLEMENTAÇÃO: SMART RESPONSE (Respond + Resume)
// ============================================================================
function smartResponse(questionType, flags, memory) {
    let answer = "";

    // =====================================================
    // RESPOSTA IMEDIATA ao que perguntou
    // =====================================================
    switch (questionType) {
        case 'price':
            answer = buildPriceAnswer(memory);
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
    // =====================================================
    const followUp = getSmartFollowUp(memory);

    return {
        action: 'smart_response',
        handler: 'leadQualificationHandler',
        text: followUp ? `${answer} ${followUp} 💚` : `${answer} 💚`,
        extractedInfo: extractFromFlags(flags),
        questionAnswered: questionType
    };
}

// ============================================================================
// 🔄 IMPLEMENTAÇÃO: CONTINUE COLLECTION
// ============================================================================
function continueCollection(memory) {
    const followUp = getSmartFollowUp(memory);

    return {
        action: 'continue_collection',
        handler: 'leadQualificationHandler',
        text: followUp ? `${followUp} 💚` : "Como posso te ajudar? 💚",
        extractedInfo: {}
    };
}

// ============================================================================
// 💰 BUILD PRICE ANSWER: Valor do Trabalho → Urgência → Preço
// ============================================================================
function buildPriceAnswer(memory) {
    const therapy = memory?.therapyArea;
    const age = memory?.patientAge || memory?.patientInfo?.age;

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

    // Montar resposta completa
    return urgencia
        ? `${valor} ${urgencia} ${preco}`
        : `${valor} ${preco}`;
}

// ============================================================================
// 🎯 GET SMART FOLLOW UP (Retoma naturalmente baseado no que falta)
// ============================================================================
function getSmartFollowUp(memory) {
    const hasTherapy = !!memory?.therapyArea;
    const hasComplaint = !!(memory?.complaint || memory?.primaryComplaint);
    const hasAge = !!(memory?.patientAge || memory?.patientInfo?.age);
    const hasPeriod = !!(memory?.preferredPeriod || memory?.pendingPreferredPeriod);

    // Ordem natural: complaint → age → period
    // (therapy geralmente já vem da queixa ou é perguntado de forma natural)

    if (!hasComplaint && hasTherapy) {
        return "O que você tem observado que te preocupa?";
    }

    if (!hasAge) {
        return "Qual a idade do paciente?";
    }

    if (!hasPeriod) {
        return "Prefere manhã ou tarde?";
    }

    if (!hasTherapy && hasComplaint) {
        return "É pra qual área você está procurando: Fono, Psicologia, TO, Fisio ou Neuropsico?";
    }

    // Tem tudo → oferece slots
    return "Quer que eu veja os horários disponíveis?";
}

// ============================================================================
// 🔍 DETECT DIRECT QUESTION
// ============================================================================
function detectDirectQuestion(flags = {}) {
    if (flags.asksPrice || flags.asksAboutPrice || flags.insistsPrice) return 'price';
    if (flags.asksAddress || flags.asksLocation) return 'address';
    if (flags.asksPlans || flags.mentionsInsurance || flags.asksInsurance) return 'plans';
    if (flags.asksSchedule || flags.asksDays || flags.asksTimes || flags.wantsSchedule) return 'schedule';
    if (flags.asksSpecialtyAvailability || flags.asksTherapyInfo) return 'specialty';
    return null;
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
