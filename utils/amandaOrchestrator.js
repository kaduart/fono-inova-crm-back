// utils/amandaOrchestrator.js - VERSÃO FINAL (COM CONTEXTO LEVE)

import Anthropic from "@anthropic-ai/sdk";
import Message from '../models/Message.js';
import { getManual } from './amandaIntents.js';
import { SYSTEM_PROMPT_AMANDA } from './amandaPrompt.js';
import { detectAllFlags } from './flagsDetector.js'; // ✅ ADICIONAR
import { buildEquivalenceResponse } from './responseBuilder.js';
import {
    detectAllTherapies,
    getTherapyData,
    isAskingAboutEquivalence
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
    const enrichedContext = await getBasicContext(lead._id, context);

    // ===== 1. TERAPIAS ESPECÍFICAS =====
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

    // ===== 2. EQUIVALÊNCIA =====
    // ===== 2. EQUIVALÊNCIA =====
    if (isAskingAboutEquivalence(text)) {
        return buildEquivalenceResponse();
    }

    // ===== 3. MANUAL =====
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

    // ✅ Monta contexto de terapias
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

    // ✅ Contexto do lead
    const { stage, messageCount, lastMessages, mentionedTherapies } = context;

    // ✅ Perfil detectado
    const profileContext = flags.userProfile !== 'generic'
        ? `\nPerfil detectado: ${flags.userProfile}`
        : '';

    // ✅ Histórico
    const historyContext = lastMessages.length > 0
        ? `\nÚltimas mensagens: ${lastMessages.slice(0, 3).join(' | ')}`
        : '';

    const userPrompt = `
MENSAGEM DO CLIENTE: "${userText}"
LEAD: ${lead?.name || 'Desconhecido'} | Origem: ${lead?.origin || 'WhatsApp'}
ESTÁGIO: ${stage.toUpperCase()} (${messageCount} mensagens)${profileContext}${historyContext}

TERAPIAS DETECTADAS:
${therapiesInfo}

FLAGS IMPORTANTES:
- Perguntou preço? ${flags.asksPrice ? 'SIM' : 'NÃO'}
- Quer agendar? ${flags.wantsSchedule ? 'SIM' : 'NÃO'}
- Pergunta horários? ${flags.asksHours ? 'NÃO' : 'NÃO'}

INSTRUÇÕES:
1. Use os DADOS DAS TERAPIAS acima como referência
2. ${flags.asksPrice ? 'Lead perguntou preço - use VALOR→PREÇO→PERGUNTA' : 'Apresente a terapia de forma acolhedora'}
3. ${flags.wantsSchedule ? 'Lead quer agendar - seja DIRETA e ofereça horários' : 'Termine com pergunta engajadora'}
4. Responda em 1-3 frases, tom humano e natural
5. Use exatamente 1 💚 no final

IMPORTANTE: Não seja robótica. Adapte a resposta ao contexto da conversa!
`.trim();

    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        temperature: 0.7, // ✅ Mais criativo para terapias
        system: SYSTEM_PROMPT_AMANDA,
        messages: [{
            role: "user",
            content: userPrompt
        }]
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}

/**
 * 📊 CONTEXTO BÁSICO (usa dados que JÁ EXISTEM)
 */
async function getBasicContext(leadId, baseContext = {}) {
    // Se não tem leadId, retorna contexto básico
    if (!leadId) {
        return {
            stage: 'novo',
            messageCount: 0,
            lastMessages: baseContext.lastMessages || [],
            alreadyAskedPrice: false,
            mentionedTherapies: []
        };
    }

    try {
        // ✅ Busca mensagens do lead (já estão no banco!)
        const messages = await Message.find({
            lead: leadId,
            type: 'text'
        })
            .sort({ timestamp: -1 })
            .limit(10)
            .lean();

        const messageCount = messages.length;
        const lastMessages = messages.slice(0, 5).map(m => m.content || '');

        // ✅ Detecta padrões simples
        const alreadyAskedPrice = messages.some(m => /pre[cç]o|valor|quanto/i.test(m.content || ''));
        const wantsSchedule = messages.some(m => /agend|marcar|hor[aá]rio/i.test(m.content || ''));

        // ✅ Detecta terapias mencionadas
        const mentionedTherapies = new Set();
        messages.forEach(m => {
            const content = (m.content || '').toLowerCase();
            if (/neuropsic/i.test(content)) mentionedTherapies.add('neuropsicológica');
            if (/fono/i.test(content)) mentionedTherapies.add('fonoaudiologia');
            if (/psic[oó]log/i.test(content)) mentionedTherapies.add('psicologia');
        });

        // ✅ Determina estágio simples
        let stage = 'novo';
        if (wantsSchedule) stage = 'interessado_agendamento';
        else if (alreadyAskedPrice) stage = 'pesquisando_preco';
        else if (messageCount >= 3) stage = 'engajado';
        else if (messageCount > 0) stage = 'primeiro_contato';

        console.log(`📊 [CONTEXTO] Stage: ${stage} | Msgs: ${messageCount} | Terapias: ${Array.from(mentionedTherapies).join(', ')}`);

        return {
            stage,
            messageCount,
            lastMessages,
            alreadyAskedPrice,
            mentionedTherapies: Array.from(mentionedTherapies)
        };

    } catch (error) {
        console.warn('⚠️ Erro ao buscar contexto:', error.message);
        return {
            stage: 'novo',
            messageCount: 0,
            lastMessages: [],
            alreadyAskedPrice: false,
            mentionedTherapies: []
        };
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
 * 🤖 IA COM CONTEXTO INTELIGENTE (ANTHROPIC)
 */
async function callOpenAIWithContext(userText, lead, context) {
    const {
        stage = 'novo',
        messageCount = 0,
        lastMessages = [],
        alreadyAskedPrice = false,
        mentionedTherapies = []
    } = context;

    // ✅ INSTRUÇÕES POR ESTÁGIO
    let stageInstruction = '';

    switch (stage) {
        case 'novo':
            stageInstruction = '• Seja acolhedora e empática. Pergunte a necessidade antes de falar de preços.';
            break;
        case 'primeiro_contato':
            stageInstruction = '• Seja calorosa. Faça perguntas abertas sobre a necessidade.';
            break;
        case 'pesquisando_preco':
            stageInstruction = '• Lead já perguntou sobre valores. Use estratégia VALOR→PREÇO→ENGAJAMENTO. Exemplo: "A avaliação é completa e personalizada. Valor: R$ 220. É para criança ou adulto?"';
            break;
        case 'engajado':
            stageInstruction = `• Lead já trocou ${messageCount} mensagens. Seja mais direta e objetiva. Facilite o caminho para agendamento.`;
            break;
        case 'interessado_agendamento':
            stageInstruction = '• Lead quer agendar! Ofereça 2 opções concretas de horário. Seja DIRETA.';
            break;
    }

    // ✅ CONTEXTO DE TERAPIAS JÁ MENCIONADAS
    const therapiesContext = mentionedTherapies.length > 0
        ? `\nTerapias já mencionadas: ${mentionedTherapies.join(', ')}`
        : '';

    // ✅ HISTÓRICO RECENTE
    const historyContext = lastMessages.length > 0
        ? `\nÚltimas mensagens: ${lastMessages.slice(0, 3).join(' | ')}`
        : '';

    const userPrompt = `
MENSAGEM DO CLIENTE: "${userText}"
LEAD: ${lead?.name || 'Desconhecido'} | Origem: ${lead?.origin || 'WhatsApp'}
ESTÁGIO: ${stage.toUpperCase()} (${messageCount} mensagens trocadas)
${historyContext}
${therapiesContext}

INSTRUÇÃO CONTEXTUAL:
${stageInstruction}

REGRAS GERAIS:
- Responda em 1-3 frases, tom humano e acolhedor
- Se perguntar sobre especialidades, mencione: Fono, Psicologia, TO, Fisio, Neuro
- SEMPRE finalize com 1 pergunta objetiva para engajar
- Use exatamente 1 💚 no final
`.trim();

    // ✅ ANTHROPIC API
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
 */
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, '').trim();
    return `${clean} 💚`;
}

export default getOptimizedAmandaResponse;