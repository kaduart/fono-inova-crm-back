import 'dotenv/config';
import Anthropic from "@anthropic-ai/sdk";
import enrichLeadContext from "../services/leadContext.js";
import { getManual } from './amandaIntents.js';
import { SYSTEM_PROMPT_AMANDA } from './amandaPrompt.js';
import { detectAllFlags } from './flagsDetector.js';
import { buildEquivalenceResponse } from './responseBuilder.js';
import {
    detectAllTherapies,
    isAskingAboutEquivalence,
    isTDAHQuestion,
    getTDAHResponse
} from './therapyDetector.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * 🎯 ORQUESTRADOR COM CONTEXTO LEVE
 */
export async function getOptimizedAmandaResponse({ content, userText, lead = {}, context = {} }) {
    const text = userText || content || "";
    const normalized = text.toLowerCase().trim();

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // ✅ CONTEXTO LEVE (busca dados que JÁ EXISTEM no banco)
    const enrichedContext = lead._id
        ? await enrichLeadContext(lead._id)
        : { ...context, stage: 'novo', isFirstContact: true, messageCount: 0 };

    // ===== 1. TDAH - RESPOSTA ESPECÍFICA =====
    if (isTDAHQuestion(text)) {
        console.log('🧠 [TDAH] Pergunta sobre tratamento TDAH detectada');
        return getTDAHResponse(lead?.name);
    }

    // ===== 2. TERAPIAS ESPECÍFICAS =====  ← RENUMERAR (antes era 1)
    const therapies = detectAllTherapies(text);

    if (therapies.length > 0) {
        console.log(`🎯 [TERAPIAS] Detectadas: ${therapies.map(t => t.id).join(', ')}`);

        // ✅ Busca flags
        const flags = detectAllFlags(text, lead, enrichedContext);

        console.log(`🏁 [FLAGS]`, {
            asksPrice: flags.asksPrice,
            wantsSchedule: flags.wantsSchedule,
            userProfile: flags.userProfile
        });

        // ✅ CHAMA IA COM DADOS DAS TERAPIAS (não resposta fixa)
        const aiResponse = await callClaudeWithTherapyData({
            therapies,
            flags,
            userText: text,
            lead,
            context: enrichedContext
        });

        return ensureSingleHeart(aiResponse);
    }

    // ===== 3. EQUIVALÊNCIA =====
    if (isAskingAboutEquivalence(text)) {
        return buildEquivalenceResponse();
    }

    // ===== 4. MANUAL =====
    const manualResponse = tryManualResponse(normalized);
    if (manualResponse) {
        console.log(`✅ [ORCHESTRATOR] Resposta do manual`);
        return ensureSingleHeart(manualResponse);
    }

    // ===== 4. IA COM CONTEXTO =====
    console.log(`🤖 [ORCHESTRATOR] IA | Stage: ${enrichedContext.stage} | Msgs: ${enrichedContext.messageCount}`);
    try {
        const aiResponse = await callOpenAIWithContext(text, lead, enrichedContext);
        return ensureSingleHeart(aiResponse);
    } catch (error) {
        console.error(`❌ [ORCHESTRATOR] Erro na IA:`, error.message);
        return "Vou verificar e já te retorno, por favor um momento 💚";
    }
}

/**
 * 🤖 IA COM DADOS DE TERAPIAS (contextualizada)
 */
async function callClaudeWithTherapyData({ therapies, flags, userText, lead, context }) {
    const { getTherapyData } = await import('./therapyDetector.js');

    // ✅ BUSCA INSIGHTS APRENDIDOS
    const { getLatestInsights } = await import('../services/amandaLearningService.js');
    const insights = await getLatestInsights();

    const therapiesInfo = therapies.map(t => {
        const data = getTherapyData(t.id);
        return `
${t.name.toUpperCase()}:
- Explicação: ${data.explanation}
- Preço: ${data.price}
- Detalhes: ${data.details}
- Pergunta engajadora: ${data.engagement}
        `.trim();
    }).join('\n\n');

    const {
        stage, messageCount, lastMessages, mentionedTherapies,
        isPatient, hasAppointments, needsUrgency, daysSinceLastContact
    } = context;

    const profileContext = flags.userProfile !== 'generic'
        ? `\nPerfil detectado: ${flags.userProfile}`
        : '';

    const historyContext = lastMessages.length > 0
        ? `\nÚltimas mensagens: ${lastMessages.slice(0, 3).join(' | ')}`
        : '';

    const patientStatus = isPatient
        ? `\n⚠️ IMPORTANTE: Este lead JÁ É PACIENTE da clínica!`
        : '';

    const appointmentStatus = hasAppointments
        ? `\n✅ Lead já tem agendamentos marcados`
        : '';

    const urgencyNote = needsUrgency
        ? `\n🔥 URGÊNCIA: ${daysSinceLastContact} dias sem contato - seja mais proativa!`
        : '';

    // ✅ INSIGHTS APRENDIDOS
    let learnedContext = '';
    if (insights?.data) {
        // Busca melhor resposta de preço para o cenário
        if (flags.asksPrice) {
            const scenario = stage === 'novo' ? 'first_contact' :
                stage === 'engajado' ? 'engaged' : 'returning';

            const bestPriceResponse = insights.data.effectivePriceResponses
                ?.find(r => r.scenario === scenario);

            if (bestPriceResponse) {
                learnedContext += `\n💡 INSIGHT: Respostas sobre preço que converteram em "${scenario}":\n"${bestPriceResponse.response}"`;
            }
        }

        // Busca melhor pergunta de fechamento
        if (stage === 'engajado' || stage === 'interessado_agendamento') {
            const topQuestion = insights.data.successfulClosingQuestions?.[0];
            if (topQuestion) {
                learnedContext += `\n💡 PERGUNTA DE SUCESSO: "${topQuestion.question}"`;
            }
        }
    }

    const userPrompt = `
MENSAGEM DO CLIENTE: "${userText}"
LEAD: ${lead?.name || 'Desconhecido'} | Origem: ${lead?.origin || 'WhatsApp'}
ESTÁGIO: ${stage.toUpperCase()} (${messageCount} mensagens)${profileContext}${historyContext}${patientStatus}${appointmentStatus}${urgencyNote}${learnedContext}

TERAPIAS DETECTADAS:
${therapiesInfo}

FLAGS IMPORTANTES:
- Perguntou preço? ${flags.asksPrice ? 'SIM' : 'NÃO'}
- Quer agendar? ${flags.wantsSchedule ? 'SIM' : 'NÃO'}
- Pergunta horários? ${flags.asksHours ? 'SIM' : 'NÃO'}

INSTRUÇÕES:
1. Use os DADOS DAS TERAPIAS acima como referência
2. ${flags.asksPrice ? 'Lead perguntou preço - use VALOR→PREÇO→PERGUNTA (veja INSIGHT acima)' : 'Apresente a terapia de forma acolhedora'}
3. ${flags.wantsSchedule ? 'Lead quer agendar - seja DIRETA e ofereça horários' : 'Termine com pergunta engajadora (veja INSIGHT acima)'}
4. ${isPatient ? 'TOM DIFERENCIADO: Paciente ativo - seja mais próxima e solícita' : 'Tom acolhedor de captação'}
5. ${needsUrgency ? 'REATIVAÇÃO: Faz tempo sem falar - seja calorosa e mostre que sentiu falta!' : ''}
6. Responda em 1-3 frases, tom humano e natural
7. Use exatamente 1 💚 no final

IMPORTANTE: Use os INSIGHTS aprendidos mas adapte ao contexto. Não seja robótica!
`.trim();

    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        temperature: 0.7,
        system: SYSTEM_PROMPT_AMANDA,
        messages: [{ role: "user", content: userPrompt }]
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}

/**
 * 📖 MANUAL
 */
function tryManualResponse(normalizedText) {
    if (/\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(normalizedText)) {
        return getManual('localizacao', 'endereco');
    }

    if (/\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/.test(normalizedText)) {
        return getManual('planos_saude', 'unimed');
    }

    if (/\b(pre[cç]o|valor|quanto.*custa)\b/.test(normalizedText) &&
        !/\b(neuropsic|fono|psico|terapia|fisio|musico)\b/.test(normalizedText)) {
        return getManual('valores', 'consulta');
    }

    if (/^(oi|ol[aá]|boa\s*(tarde|noite|dia)|bom\s*dia)[\s!,.]*$/i.test(normalizedText)) {
        return getManual('saudacao');
    }

    return null;
}

/**
 * 🤖 IA COM CONTEXTO INTELIGENTE (ANTHROPIC)
 */
async function callOpenAIWithContext(userText, lead, context) {
    const {
        stage = 'novo',
        messageCount = 0,
        lastMessages = [],
        mentionedTherapies = [],
        isPatient = false,
        hasAppointments = false,
        needsUrgency = false,
        daysSinceLastContact = 0
    } = context;

    let stageInstruction = '';

    switch (stage) {
        case 'novo':
            stageInstruction = '• Seja acolhedora e empática. Pergunte a necessidade antes de falar de preços.';
            break;
        case 'primeiro_contato':
            stageInstruction = '• Seja calorosa. Faça perguntas abertas sobre a necessidade.';
            break;
        case 'pesquisando_preco':
            stageInstruction = '• Lead já perguntou sobre valores. Use estratégia VALOR→PREÇO→ENGAJAMENTO.';
            break;
        case 'engajado':
            stageInstruction = `• Lead já trocou ${messageCount} mensagens. Seja mais direta e objetiva.`;
            break;
        case 'interessado_agendamento':
            stageInstruction = '• Lead quer agendar! Ofereça 2 opções concretas de horário. Seja DIRETA.';
            break;
        case 'agendado':
            stageInstruction = '• Lead JÁ TEM AGENDAMENTO! Confirme horário ou tire dúvidas. Seja prestativa.';
            break;
        case 'paciente':
            stageInstruction = '• PACIENTE ATIVO! Tom próximo e solícito. Pergunte como está o tratamento.';
            break;
    }

    const patientNote = isPatient
        ? `\n⚠️ IMPORTANTE: Lead JÁ É PACIENTE. Seja mais próxima e atenciosa!`
        : '';

    const urgencyNote = needsUrgency
        ? `\n🔥 ${daysSinceLastContact} dias sem contato - seja calorosa: "Que saudade! Como você está?"`
        : '';

    // ✅ CORREÇÃO PRINCIPAL - USA HISTÓRICO DE TERAPIAS
    const therapiesContext = mentionedTherapies.length > 0
        ? `\n🎯 TERAPIAS NO HISTÓRICO: ${mentionedTherapies.join(', ')}`
        : '';

    const historyContext = lastMessages.length > 0
        ? `\nÚltimas mensagens: ${lastMessages.slice(0, 3).join(' | ')}`
        : '';

    const userPrompt = `
MENSAGEM DO CLIENTE: "${userText}"
LEAD: ${lead?.name || 'Desconhecido'} | Origem: ${lead?.origin || 'WhatsApp'}
ESTÁGIO: ${stage.toUpperCase()} (${messageCount} mensagens trocadas)${historyContext}${therapiesContext}${patientNote}${urgencyNote}

INSTRUÇÃO CONTEXTUAL:
${stageInstruction}

REGRAS GERAIS:
- Responda em 1-3 frases, tom humano e acolhedor
- ${mentionedTherapies.length > 0 ? `🚨 CRÍTICO: Lead já demonstrou interesse em ${mentionedTherapies.join(' e ')}. Mantenha foco NESSAS especialidades. NÃO ofereça outras sem o lead perguntar!` : 'Se perguntar sobre especialidades, mencione: Fono, Psicologia, TO, Fisio, Neuro'}
- SEMPRE finalize com 1 pergunta objetiva para engajar
- Use exatamente 1 💚 no final
`.trim();

    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 150,
        temperature: 0.6,
        system: SYSTEM_PROMPT_AMANDA,
        messages: [{
            role: "user",
            content: userPrompt
        }]
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}


/**
 * 🎨 HELPER
* **/
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, '').trim();
    return `${clean} 💚`;
}

export default getOptimizedAmandaResponse;