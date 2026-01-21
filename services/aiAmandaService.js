

import axios from "axios";
import OpenAI from "openai";
import { Readable } from "stream";

import getOptimizedAmandaResponse from "../utils/amandaOrchestrator.js";
import { CLINIC_ADDRESS, SYSTEM_PROMPT_AMANDA } from "../utils/amandaPrompt.js";

// ⚠️ novos imports para mídia baseada em mediaId
import ensureSingleHeart from "../utils/helpers.js";
import callAI from "./IA/Aiproviderservice.js";
import { analyzeLeadMessage } from "./intelligence/leadIntelligence.js";
import { getMediaBuffer } from "./whatsappMediaService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================================
   🎯 RESPOSTA PRINCIPAL - USA ORCHESTRATOR (MANTIDO)
   ========================================================================= */

export async function generateAmandaReply({ userText, lead = {}, context = {} }) {

    try {
        return await getOptimizedAmandaResponse({
            content: userText,
            userText,
            lead,
            context,
        });

    } catch (err) {

        console.warn("⚠️ Orchestrator falhou, usando OpenAI FREE");

        try {
            const fallback = await callOpenAIFallback({
                systemPrompt: SYSTEM_PROMPT_AMANDA,
                messages: [
                    { role: "user", content: userText }
                ]
            });

            if (fallback) return fallback;

        } catch (e) {
            console.error("❌ Fallback OpenAI falhou:", e.message);
        }

        return "Tive um probleminha técnico 😕 Já te ajudo 💚";
    }
}

/* =========================================================================
   📞 FOLLOW-UP (AGORA USANDO leadIntelligence + CENÁRIOS)
   ========================================================================= */
export async function generateFollowupMessage(lead) {
    const name = lead?.name?.split(" ")[0] || "tudo bem";
    const reason = (lead?.reason || "avaliação/terapia").trim();
    const origin = lead?.origin || "WhatsApp";

    // 🔎 Pega a última interação registrada no lead
    const lastInteraction = Array.isArray(lead?.interactions) && lead.interactions.length > 0
        ? lead.interactions[lead.interactions.length - 1]
        : null;

    const lastMsg = (lastInteraction?.message || "").trim();
    const lastMsgDesc = lastMsg || reason || "há alguns dias vocês conversaram sobre avaliação/terapia";

    // ⏱️ dias desde a última interação (se o modelo de lead tiver isso)
    const lastAt = lead.lastInteractionAt ? new Date(lead.lastInteractionAt).getTime() : null;
    const now = Date.now();
    const daysSinceLast = lastAt ? Math.round((now - lastAt) / (1000 * 60 * 60 * 24)) : null;

    // 🧠 Analisa intenção, urgência, score etc. usando o teu leadIntelligence
    let analysis = null;
    try {
        analysis = await analyzeLeadMessage({
            text: lastMsgDesc,
            lead,
            history: Array.isArray(lead.interactions) ? lead.interactions : [],
        });
    } catch (err) {
        console.error("⚠️ Erro em analyzeLeadMessage no follow-up:", err.message);
    }

    const extracted = analysis?.extracted || {};
    const intent = analysis?.intent || {};
    const stage = lead.stage || 'novo';

    const segment = analysis?.segment || {
        label: lead.conversionScore >= 80 ? "hot" : lead.conversionScore >= 50 ? "warm" : "cold",
        emoji: lead.conversionScore >= 80 ? "🔥" : lead.conversionScore >= 50 ? "🟡" : "🧊",
    };

    // 🧩 Sinais de contexto específicos da ÚLTIMA fala
    const talksAboutPrice =
        /(pre[çc]o|valor|valores|custa|mensalidade|pacote|tabela|orçamento|orcamento)/i.test(lastMsgDesc);

    const talksAboutThinking =
        /(vou\s+ver|vou\s+avaliar|vou\s+pensar|vou\s+conversar\s+com|depois\s+te\s+dou\s+retorno)/i
            .test(lastMsgDesc);

    const saidWillTalkToSpouseOrFamily =
        /(vou\s+(falar|conversar)\s+com\s+(meu\s+marido|minha\s+esposa|minha\s+mulher|meu\s+esposo|minha\s+companheira|meu\s+companheiro|minha\s+m[aã]e|meu\s+pai|meus\s+pais|fam[ií]lia))/i
            .test(lastMsgDesc);

    const saidWillCheckPlan =
        /\b(vou\s+ver|vou\s+checar|vou\s+olhar)\b.*\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/i
            .test(lastMsgDesc);

    const saidWillCheckSchedule =
        /\b(vou\s+ver|vou\s+olhar|vou\s+organizar)\b.*\b(agenda|hor[aá]rio|rotina)\b/i
            .test(lastMsgDesc);

    const askedForHuman =
        /(falar\s+com\s+atendente|falar\s+com\s+uma\s+pessoa|secret[aá]ria|atendente)/i.test(lastMsgDesc);

    // 🔙 Se a última mensagem foi pedindo atendente humana, é mais seguro NÃO mandar follow-up automático
    if (askedForHuman) {
        console.log("[Followup] Última mensagem pediu atendente humana — não envia follow-up automático.");
        return null;
    }

    // 🎯 Template-base só como "clima" / fallback
    const baseTemplateValores = `Oi, ${name}! 😊
    Só passei para ver se conseguiu analisar os valores e se posso te ajudar com algo mais 💚

    Se quiser, já te envio os horários disponíveis para a avaliação ✨`;

    const baseTemplateGeral = `Oi, ${name}! 😊
    Só passei para saber se conseguiu ver com calma as informações que combinamos e se posso te ajudar com algo a mais 💚

    Se quiser, já te envio os horários disponíveis para a avaliação ✨`;

    const baseTemplate = talksAboutPrice || talksAboutThinking ? baseTemplateValores : baseTemplateGeral;

    // 🧠 Monta descrição de cenário pra IA enxergar o contexto
    const scenarioNotes = [];

    scenarioNotes.push(`- Segmento atual: ${segment.label.toUpperCase()} ${segment.emoji}`);
    scenarioNotes.push(`- Intenção primária detectada: ${intent.primary || "duvida_geral"}`);
    scenarioNotes.push(`- Urgência detectada: ${extracted.urgencia || "normal"}`);

    if (daysSinceLast != null) {
        scenarioNotes.push(`- Dias sem resposta: ${daysSinceLast} dia(s)`);
    }

    if (talksAboutPrice) {
        scenarioNotes.push("- O lead falou de valores/preço na última conversa.");
    }
    if (talksAboutThinking) {
        scenarioNotes.push("- O lead disse que iria pensar/ver melhor antes de decidir.");
    }
    if (saidWillTalkToSpouseOrFamily) {
        scenarioNotes.push("- O lead disse que iria conversar com marido/esposa/família.");
    }
    if (saidWillCheckPlan) {
        scenarioNotes.push("- O lead disse que iria ver questão de plano/convênio.");
    }
    if (saidWillCheckSchedule) {
        scenarioNotes.push("- O lead disse que iria ver agenda/horário/rotina.");
    }

    const scenarioBlock = scenarioNotes.join("\n");

    // 🧾 Prompt COMPLETO que guia o Claude, agora com CENÁRIO explícito
    const userPrompt = `
    Quero que você gere UMA mensagem curta de follow-up para um lead da Clínica Fono Inova.

    DADOS DO LEAD:
    - Nome: ${name}
    - Origem: ${origin}
    - Motivo/razão: ${reason}
    - Última interação relevante: "${lastMsgDesc}"
    - Estágio atual do lead no funil: ${stage}

    CENÁRIO ANALISADO (via inteligência interna):
    ${scenarioBlock || "- Cenário geral de retomada após envio de informações."}

    INTERPRETAÇÃO DO CENÁRIO:
    - Se o lead falou que iria conversar com marido/esposa/família, a mensagem deve relembrar isso de forma acolhedora (ex.: "vocês chegaram a conversar sobre isso?").
    - Se o lead falou que iria ver valores/contas, a mensagem deve reconhecer isso com leveza (sem pressionar) e reforçar o valor da avaliação/visita.
    - Se o lead falou que iria ver plano/convênio, a mensagem pode reforçar que muitas famílias usam plano, mas buscam o particular para começar mais rápido.
    - Se o lead falou que iria ver agenda/rotina, acolha a correria e mostre que dá para começar de forma leve.
    - Se o segmento for HOT (🔥), você pode ser um pouco mais direto ao oferecer ajuda para escolher dia/turno.
    - Se o segmento for COLD (🧊), a mensagem deve ser bem leve, mais lembrando que estamos à disposição do que cobrando decisão.

    ESTILO BASE (NÃO COPIAR IGUAL, SÓ O CLIMA):
    "${baseTemplate}"

    REGRAS DE ESTILO:
    - 2 a 3 frases no máximo.
    - Tom leve, humano, nada robótico.
    - Tratar o lead pelo primeiro nome.
    - Se houver contexto de valores, mencionar de forma suave que está vendo se conseguiu analisar os valores.
    - Em todos os casos, oferecer ajuda + possibilidade de enviar horários disponíveis para avaliação ou visita.
    - Sempre terminar com uma pergunta de ESCOLHA BINÁRIA (por exemplo: "ficou melhor essa semana ou prefere deixar para a próxima?", "prefere primeiro ver horários ou tirar mais uma dúvida?").
    - Exatamente 1 💚 na mensagem inteira.
    - Pode usar 1 ou 2 emojis leves (😊, ✨), sem exagero.
    - NÃO insista demais: é um lembrete educado, não cobrança.

    DADOS NUMÉRICOS:
    - Score atual: ${lead.conversionScore ?? "sem score"}/100
    - Nível de urgência interna: ${lead.qualificationData?.urgencyLevel || 2}/3
    - Segmento (interno): ${segment.label.toUpperCase()} ${segment.emoji}

    Gere APENAS o texto da mensagem pronta para ser enviada no WhatsApp, em português do Brasil.`.trim();

    try {
        const text = await callAI({
            systemPrompt: SYSTEM_PROMPT_AMANDA,
            messages: [{ role: "user", content: userPrompt }],
            maxTokens: 220,
            temperature: 0.7
        });

        // Se por algum motivo vier vazio, usa o template base
        const final = text || baseTemplate;
        return ensureSingleHeart(final); // garante só 1 💚
    } catch (error) {
        console.error("❌ Erro ao gerar follow-up:", error);
        // fallback se Claude der pau
        return ensureSingleHeart(baseTemplate);
    }
}


/* =========================================================================
   🎙️ TRANSCRIÇÃO DE ÁUDIO - VERSÃO NOVA (mediaId → buffer → Whisper)
   ========================================================================= */
export async function transcribeWaAudio(mediaId, fileName = "audio.ogg") {
    console.log(`🎙️ Iniciando transcrição: ${mediaId}`);

    try {
        // 1️⃣ Baixa o áudio via Graph (service unificado)
        const { buffer, mimeType } = await getMediaBuffer(mediaId);

        console.log(`📊 Áudio: ${buffer.length} bytes, tipo: ${mimeType}`);

        const stream = Readable.from(buffer);
        stream.path = fileName;

        const resp = await openai.audio.transcriptions.create({
            file: stream,
            model: "whisper-1",
            language: "pt",
            temperature: 0.2,
        });

        return (resp?.text || "").trim();
    } catch (error) {
        console.error("❌ Erro na transcrição (transcribeWaAudio):", error.message);
        return "";
    }
}

/* =========================================================================
   🎙️ TRANSCRIÇÃO DE ÁUDIO - VERSÃO ANTIGA (URL direta)
   → Mantida por compatibilidade, se ainda houver código chamando
   ========================================================================= */
export async function transcribeWaAudioFromGraph({
    mediaUrl,
    fileName = "audio.ogg",
} = {}) {
    try {
        const { data } = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            timeout: 20000,
        });

        const buffer = Buffer.from(data);
        const stream = Readable.from(buffer);
        stream.path = fileName;

        const resp = await openai.audio.transcriptions.create({
            file: stream,
            model: "whisper-1",
            language: "pt",
            temperature: 0.2,
        });

        return (resp?.text || "").trim();
    } catch (error) {
        console.error("❌ Erro ao transcrever áudio (FromGraph):", error.message);
        return "";
    }
}

// =====================================================================
// 🔄 FALLBACK OPENAI (quando Anthropic falha)
// =====================================================================
export async function callOpenAIFallback({ systemPrompt, messages, maxTokens = 200, temperature = 0.7 }) {
    const openaiMessages = [
        { role: "system", content: systemPrompt },
        ...messages.map(msg => ({
            role: msg.role,
            content: typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content)
        }))
    ];

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: openaiMessages,
        max_tokens: maxTokens,
        temperature
    });

    return response.choices[0]?.message?.content?.trim() || null;
}
/* =========================================================================
   🖼️ DESCRIÇÃO DE IMAGEM - NOVA (mediaId → buffer → dataURL → GPT-4o-mini)
   ========================================================================= */
export async function describeWaImage(mediaId, caption = "") {
    console.log(`🖼️ Processando imagem: ${mediaId}`);

    try {
        // 1️⃣ Baixa o binário da mídia (como já faz com áudio)
        const { buffer, mimeType } = await getMediaBuffer(mediaId);

        console.log(`🖼️ Imagem carregada: ${buffer.length} bytes, tipo: ${mimeType}`);

        // 2️⃣ Converte para data URL (base64)
        const base64 = buffer.toString("base64");
        const dataUrl = `data:${mimeType || "image/jpeg"};base64,${base64}`;

        // 3️⃣ Envia para o GPT-4o-mini usando image_url com data URL
        const resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.4,
            max_tokens: 120,
            messages: [
                {
                    role: "system",
                    content:
                        "Você é a Amanda da Clínica Fono Inova. Descreva brevemente a imagem em 1-2 frases, em pt-BR.",
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Legenda: ${caption || "(sem legenda)"}`,
                        },
                        {
                            type: "image_url",
                            image_url: { url: dataUrl },
                        },
                    ],
                },
            ],
        });

        return (resp.choices?.[0]?.message?.content || "").trim();
    } catch (error) {
        console.error("❌ Erro ao descrever imagem (describeWaImage):", error.message);
        return "";
    }
}


/* =========================================================================
   🖼️ DESCRIÇÃO DE IMAGEM - ANTIGA (URL direta)
   → Mantida por compatibilidade
   ========================================================================= */
export async function describeWaImageFromGraph({ imageUrl, caption = "" } = {}) {
    try {
        const resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.4,
            max_tokens: 120,
            messages: [
                {
                    role: "system",
                    content:
                        "Você é a Amanda da Clínica Fono Inova. Descreva brevemente a imagem em 1-2 frases, em pt-BR.",
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Legenda: ${caption || "(sem legenda)"}` },
                        { type: "image_url", image_url: { url: imageUrl } },
                    ],
                },
            ],
        });

        return (resp.choices?.[0]?.message?.content || "").trim();
    } catch (error) {
        console.error(
            "❌ Erro ao descrever imagem (FromGraph):",
            error.message
        );
        return "";
    }
}

// Exporta CLINIC_ADDRESS e SYSTEM_PROMPT_AMANDA para compatibilidade
export { CLINIC_ADDRESS, SYSTEM_PROMPT_AMANDA };
