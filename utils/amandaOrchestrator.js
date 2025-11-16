import Anthropic from "@anthropic-ai/sdk";
import 'dotenv/config';
import enrichLeadContext from "../services/leadContext.js"; // ← IMPORTA, não define
import { getManual } from './amandaIntents.js';
import { detectAllFlags } from './flagsDetector.js';
import { buildEquivalenceResponse } from './responseBuilder.js';
import {
    detectAllTherapies,
    getTDAHResponse,
    isAskingAboutEquivalence,
    isTDAHQuestion
} from './therapyDetector.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * 🎯 ORQUESTRADOR COM CONTEXTO INTELIGENTE
 */
export async function getOptimizedAmandaResponse({ content, userText, lead = {}, context = {} }) {
    const text = userText || content || "";
    const normalized = text.toLowerCase().trim();

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // ✅ CONTEXTO INTELIGENTE (busca de leadContext.js)
    const enrichedContext = lead._id
        ? await enrichLeadContext(lead._id)
        : { stage: 'novo', isFirstContact: true, messageCount: 0, conversationHistory: [], conversationSummary: null, shouldGreet: true };

    // ===== 1. TDAH - RESPOSTA ESPECÍFICA =====
    if (isTDAHQuestion(text)) {
        console.log('🧠 [TDAH] Pergunta sobre tratamento TDAH detectada');
        return getTDAHResponse(lead?.name);
    }

    // ===== 2. TERAPIAS ESPECÍFICAS =====
    const therapies = detectAllTherapies(text);

    if (therapies.length > 0) {
        console.log(`🎯 [TERAPIAS] Detectadas: ${therapies.map(t => t.id).join(', ')}`);

        const flags = detectAllFlags(text, lead, enrichedContext);

        console.log(`🏁 [FLAGS]`, {
            asksPrice: flags.asksPrice,
            wantsSchedule: flags.wantsSchedule,
            userProfile: flags.userProfile
        });

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

    // ===== 5. IA COM CONTEXTO =====
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
 * 🤖 IA COM DADOS DE TERAPIAS + HISTÓRICO COMPLETO + CACHE MÁXIMO
 */
async function callClaudeWithTherapyData({ therapies, flags, userText, lead, context }) {
    const { getTherapyData } = await import('./therapyDetector.js');
    const { getLatestInsights } = await import('../services/amandaLearningService.js');
    const { SYSTEM_PROMPT_AMANDA } = await import('./amandaPrompt.js');

    const insights = await getLatestInsights();

    const therapiesInfo = therapies.map(t => {
        const data = getTherapyData(t.id);
        return `${t.name.toUpperCase()}: ${data.explanation} | Preço: ${data.price}`;
    }).join('\n');

    const {
        stage, messageCount, isPatient, hasAppointments,
        needsUrgency, daysSinceLastContact,
        conversationHistory, conversationSummary, shouldGreet
    } = context;

    // ✅ INSIGHTS APRENDIDOS
    let learnedContext = '';
    if (insights?.data?.effectivePriceResponses && flags.asksPrice) {
        const scenario = stage === 'novo' ? 'first_contact' : 'engaged';
        const bestResponse = insights.data.effectivePriceResponses.find(r => r.scenario === scenario);
        if (bestResponse) {
            learnedContext = `\n💡 PADRÃO DE SUCESSO: "${bestResponse.response}"`;
        }
    }

    const patientStatus = isPatient ? `\n⚠️ PACIENTE ATIVO - Tom próximo!` : '';
    const urgencyNote = needsUrgency ? `\n🔥 ${daysSinceLastContact} dias sem falar - reative com calor!` : '';

    // 🧠 PREPARA PROMPT ATUAL
    const currentPrompt = `${userText}

📊 CONTEXTO DESTA MENSAGEM:
TERAPIAS DETECTADAS: ${therapiesInfo}
FLAGS: Preço=${flags.asksPrice} | Agendar=${flags.wantsSchedule}
ESTÁGIO: ${stage} (${messageCount} msgs totais)${patientStatus}${urgencyNote}${learnedContext}

🎯 INSTRUÇÕES CRÍTICAS:
1. ${shouldGreet ? '✅ Pode cumprimentar naturalmente' : '🚨 NÃO USE SAUDAÇÕES (Oi/Olá) - conversa está ativa'}
2. ${conversationSummary ? '🧠 Você TEM o resumo completo acima - USE esse contexto!' : '📜 Leia TODO o histórico de mensagens acima'}
3. 🚨 NÃO PERGUNTE o que JÁ foi informado/discutido
4. ${flags.asksPrice ? 'Responda preço: VALOR→PREÇO→PERGUNTA' : 'Apresente de forma acolhedora'}
5. Máximo 3 frases, tom natural e humano
6. Exatamente 1 💚 no final`;

    // 🧠 MONTA MENSAGENS COM CACHE MÁXIMO
    const messages = [];

    // 1. Resumo com cache
    if (conversationSummary) {
        messages.push({
            role: 'user',
            content: `📋 CONTEXTO DE CONVERSAS ANTERIORES:\n\n${conversationSummary}\n\n---\n\nAs mensagens abaixo são a continuação RECENTE desta conversa:`,
            cache_control: { type: "ephemeral" }
        });
        messages.push({
            role: 'assistant',
            content: 'Entendi o contexto completo. Vou continuar a conversa de forma natural, lembrando de tudo que foi discutido.'
        });
    }

    // 2. Histórico com cache na última mensagem
    if (conversationHistory.length > 0) {
        messages.push(...conversationHistory.slice(0, -1));

        const lastHistoryMsg = conversationHistory[conversationHistory.length - 1];
        messages.push({
            ...lastHistoryMsg,
            cache_control: { type: "ephemeral" }
        });
    }

    // 3. Mensagem atual (SEM cache)
    messages.push({
        role: 'user',
        content: currentPrompt
    });

    // 🚀 CHAMA ANTHROPIC COM CACHE
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        temperature: 0.7,
        system: [
            {
                type: "text",
                text: SYSTEM_PROMPT_AMANDA,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}

/**
 * 🤖 IA COM CONTEXTO INTELIGENTE + CACHE MÁXIMO
 */
async function callOpenAIWithContext(userText, lead, context) {
    const { SYSTEM_PROMPT_AMANDA } = await import('./amandaPrompt.js');

    const {
        stage = 'novo',
        messageCount = 0,
        mentionedTherapies = [],
        isPatient = false,
        needsUrgency = false,
        daysSinceLastContact = 0,
        conversationHistory = [],
        conversationSummary = null,
        shouldGreet = true
    } = context;

    let stageInstruction = '';
    switch (stage) {
        case 'novo':
            stageInstruction = 'Seja acolhedora. Pergunte necessidade antes de preços.';
            break;
        case 'pesquisando_preco':
            stageInstruction = 'Lead já perguntou valores. Use VALOR→PREÇO→ENGAJAMENTO.';
            break;
        case 'engajado':
            stageInstruction = `Lead trocou ${messageCount} msgs. Seja mais direta.`;
            break;
        case 'interessado_agendamento':
            stageInstruction = 'Lead quer agendar! Ofereça 2 períodos concretos.';
            break;
        case 'paciente':
            stageInstruction = 'PACIENTE ATIVO! Tom próximo.';
            break;
    }

    const patientNote = isPatient ? `\n⚠️ PACIENTE - seja próxima!` : '';
    const urgencyNote = needsUrgency ? `\n🔥 ${daysSinceLastContact} dias sem contato - reative!` : '';
    const therapiesContext = mentionedTherapies.length > 0
        ? `\n🎯 TERAPIAS DISCUTIDAS: ${mentionedTherapies.join(', ')}`
        : '';

    // 🧠 PREPARA PROMPT ATUAL
    const currentPrompt = `${userText}

CONTEXTO:
LEAD: ${lead?.name || 'Desconhecido'} | ESTÁGIO: ${stage} (${messageCount} msgs)${therapiesContext}${patientNote}${urgencyNote}

INSTRUÇÃO: ${stageInstruction}

REGRAS:
- ${shouldGreet ? 'Pode cumprimentar' : '🚨 NÃO use Oi/Olá - conversa ativa'}
- ${conversationSummary ? '🧠 USE o resumo acima' : '📜 Leia histórico acima'}
- 🚨 NÃO pergunte o que já foi dito
- 1-3 frases, tom humano
- 1 pergunta engajadora
- 1 💚 final`;

    // 🧠 MONTA MENSAGENS COM CACHE MÁXIMO
    const messages = [];

    // 1. Resumo com cache
    if (conversationSummary) {
        messages.push({
            role: 'user',
            content: `📋 CONTEXTO ANTERIOR:\n\n${conversationSummary}\n\n---\n\nMensagens recentes abaixo:`,
            cache_control: { type: "ephemeral" }
        });
        messages.push({
            role: 'assistant',
            content: 'Entendi o contexto. Continuando...'
        });
    }

    // 2. Histórico com cache na última mensagem
    if (conversationHistory.length > 0) {
        messages.push(...conversationHistory.slice(0, -1));

        const lastHistoryMsg = conversationHistory[conversationHistory.length - 1];
        messages.push({
            ...lastHistoryMsg,
            cache_control: { type: "ephemeral" }
        });
    }

    // 3. Mensagem atual (SEM cache)
    messages.push({
        role: 'user',
        content: currentPrompt
    });

    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 150,
        temperature: 0.6,
        system: [
            {
                type: "text",
                text: SYSTEM_PROMPT_AMANDA,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}

/**
 * 🎨 HELPER
 */
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, '').trim();
    return `${clean} 💚`;
}

export default getOptimizedAmandaResponse;