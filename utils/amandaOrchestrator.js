// utils/amandaOrchestrator.js - VERSÃO CORRIGIDA E COMPLETA

import OpenAI from "openai";
import { getManual } from './amandaIntents.js';
import { SYSTEM_PROMPT_AMANDA } from './amandaPrompt.js';
import {
    detectAllTherapies,
    generateMultiTherapyResponse,
    isAskingAboutEquivalence,
    generateEquivalenceResponse
} from './therapyDetector.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * 🎯 ORQUESTRADOR PRINCIPAL - PRIORIDADE CLARA:
 * 1. Terapias específicas (nossa estratégia VALOR→PREÇO→ENGAJAMENTO)
 * 2. Manual (respostas canônicas)
 * 3. IA (GPT-4o-mini como último recurso)
 */
export async function getOptimizedAmandaResponse({ content, userText, lead = {}, context = {} }) {
    const text = userText || content || "";
    const normalized = text.toLowerCase().trim();

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // ===== PRIORIDADE 1: TERAPIAS ESPECÍFICAS =====
    const therapies = detectAllTherapies(text);

    if (therapies.length > 0) {
        console.log(`🎯 [TERAPIAS] Detectadas: ${therapies.map(t => t.id).join(', ')}`);

        // Flags básicas necessárias
        const flags = {
            asksPrice: /\b(pre[cç]o|valor|custa|quanto)\b/i.test(normalized),
            wantsSchedule: /\b(agend|marcar|hor[aá]rio)\b/i.test(normalized),
            asksHours: /\b(hor[aá]rio.*atendimento|abre|fecha)\b/i.test(normalized)
        };

        const response = generateMultiTherapyResponse(therapies, text, flags);
        console.log(`✅ [ORCHESTRATOR] Resposta específica: ${response}`);
        return response;
    }

    // Equivalência (ex: "fono é a mesma coisa que fonoaudiologia?")
    if (isAskingAboutEquivalence(text)) {
        return generateEquivalenceResponse(text);
    }

    // ===== PRIORIDADE 2: MANUAL (RESPOSTAS CANÔNICAS) =====
    const manualResponse = tryManualResponse(normalized);
    if (manualResponse) {
        console.log(`✅ [ORCHESTRATOR] Resposta do manual`);
        return ensureSingleHeart(manualResponse);
    }

    // ===== PRIORIDADE 3: IA (ÚLTIMO RECURSO) =====
    console.log(`🤖 [ORCHESTRATOR] Usando IA para resposta genérica`);
    try {
        const aiResponse = await callOpenAI(text, lead, context);
        return ensureSingleHeart(aiResponse);
    } catch (error) {
        console.error(`❌ [ORCHESTRATOR] Erro na IA:`, error.message);
        return "Vou verificar e já te retorno, por favor um momento 💚";
    }
}

/**
 * 📖 TENTA RESPOSTA DO MANUAL (RÁPIDO)
 */
function tryManualResponse(normalizedText) {
    // Endereço
    if (/\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(normalizedText)) {
        return getManual('localizacao', 'endereco');
    }

    // Planos de saúde
    if (/\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/.test(normalizedText)) {
        return getManual('planos_saude', 'unimed');
    }

    // Valores (genérico - apenas se NÃO detectou terapia específica)
    if (/\b(pre[cç]o|valor|quanto.*custa)\b/.test(normalizedText) &&
        !/\b(neuropsic|fono|psico|terapia|fisio|musico)\b/.test(normalizedText)) {
        return getManual('valores', 'consulta');
    }

    // Saudação inicial
    if (/^(oi|ol[aá]|boa\s*(tarde|noite|dia)|bom\s*dia)[\s!,.]*$/i.test(normalizedText)) {
        return getManual('saudacao');
    }

    return null;
}

/**
 * 🤖 CHAMA OPENAI (ÚLTIMO RECURSO)
 */
async function callOpenAI(userText, lead, context) {
    const { lastMessages = [], isFirstContact = false } = context;

    // Contexto mínimo para IA
    const historyContext = lastMessages.length > 0
        ? `\nÚltimas mensagens: ${lastMessages.slice(-3).join(' | ')}`
        : '';

    const userPrompt = `
MENSAGEM DO CLIENTE: "${userText}"
LEAD: ${lead?.name || 'Desconhecido'} | Origem: ${lead?.origin || 'WhatsApp'}
${historyContext}

INSTRUÇÕES:
• Responda em 1-3 frases, tom humano e acolhedor
• Se perguntar sobre especialidades, mencione: Fono, Psicologia, TO, Fisio, Neuro
• Se perguntar sobre valores genéricos: "A avaliação inicial é R$ 220. Qual especialidade te interessa?"
• SEMPRE finalize com 1 pergunta objetiva para engajar
• Use exatamente 1 💚 no final
`.trim();

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.6,
        max_tokens: 150,
        messages: [
            { role: "system", content: SYSTEM_PROMPT_AMANDA },
            { role: "user", content: userPrompt }
        ]
    });

    return response.choices[0]?.message?.content?.trim() || "Como posso te ajudar? 💚";
}

/**
 * 🎨 GARANTE FORMATAÇÃO
 */
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, '').trim();
    return `${clean} 💚`;
}

export default getOptimizedAmandaResponse;