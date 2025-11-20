// services/aiAmandaService.js - VERSÃO UNIFICADA (Amanda 1.0 + mídia nova)
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import OpenAI from "openai";
import { Readable } from "stream";

import getOptimizedAmandaResponse from "../utils/amandaOrchestrator.js";
import { CLINIC_ADDRESS, SYSTEM_PROMPT_AMANDA } from "../utils/amandaPrompt.js";

// ⚠️ novos imports para mídia baseada em mediaId
import { getMediaBuffer, resolveMediaUrl } from "./whatsappMediaService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* =========================================================================
   🎯 RESPOSTA PRINCIPAL - USA ORCHESTRATOR (MANTIDO)
   ========================================================================= */
export async function generateAmandaReply({ userText, lead = {}, context = {} }) {
    try {
        const response = await getOptimizedAmandaResponse({
            content: userText,
            userText,
            lead,
            context,
        });

        console.log("[AmandaReply] Resposta gerada:", response);
        return response;
    } catch (error) {
        console.error("❌ Erro em generateAmandaReply:", error);
        return "Vou verificar e já te retorno, por favor um momento 💚";
    }
}

/* =========================================================================
   📞 FOLLOW-UP (MANTIDO COM CLAUDE + 💚 ÚNICO)
   ========================================================================= */
export async function generateFollowupMessage(lead) {
    const name = lead?.name?.split(" ")[0] || "tudo bem";
    const reason = lead?.reason || "avaliação/terapia";
    const origin = lead?.origin || "WhatsApp";

    // 🔎 Pega a última interação registrada no lead
    const lastInteraction = Array.isArray(lead?.interactions) && lead.interactions.length > 0
        ? lead.interactions[lead.interactions.length - 1]
        : null;

    const lastMsg = (lastInteraction?.message || "").trim();

    // 🧠 Sinais de contexto para o follow-up
    const talksAboutPrice =
        /(pre[çc]o|valor|valores|custa|mensalidade|pacote|tabela|orçamento|orcamento)/i.test(lastMsg) ||
        /(pre[çc]o|valor|valores|custa|mensalidade|pacote|tabela|orçamento|orcamento)/i.test(reason);

    const talksAboutThinking =
        /(vou\s+ver|vou\s+avaliar|vou\s+pensar|vou\s+conversar\s+com|depois\s+te\s+dou\s+retorno|ver\s+com\s+meu\s+espos[oa])/i
            .test(lastMsg);

    const askedForHuman =
        /(falar\s+com\s+atendente|falar\s+com\s+uma\s+pessoa|secret[aá]ria|atendente)/i.test(lastMsg);

    // 🎯 Template-base que você quer pra PRIMEIRO follow-up “padrão valores”
    const baseTemplateValores = `Oi, ${name}! 😊
Só passei para ver se conseguiu analisar os valores e se posso te ajudar com algo mais 💚

Se quiser, já te envio os horários disponíveis para a avaliação ✨`;

    // Versão mais genérica (quando não tá claramente falando de preço)
    const baseTemplateGeral = `Oi, ${name}! 😊
Só passei para saber se conseguiu ver com calma as informações que combinamos e se posso te ajudar com algo a mais 💚

Se quiser, já te envio os horários disponíveis para a avaliação ✨`;

    // Decide qual template usar como “âncora”
    const baseTemplate = talksAboutPrice || talksAboutThinking ? baseTemplateValores : baseTemplateGeral;

    const lastMsgDesc = lastMsg || "há alguns dias vocês conversaram sobre avaliação/terapia";

    // 🧾 Prompt COMPLETO que guia o Claude MAS mantendo o CLIMA do teu template
    const userPrompt = `
Quero que você gere uma mensagem curta de follow-up para um lead da Clínica Fono Inova.

DADOS DO LEAD:
- Nome: ${name}
- Origem: ${origin}
- Motivo/razão: ${reason}
- Última interação relevante: "${lastMsgDesc}"

CENÁRIO:
- Essa é a PRIMEIRA mensagem de follow-up depois de uma conversa onde a pessoa pediu informações,
  falou de valores ou disse que iria pensar/conversar com alguém antes de decidir.

ESTILO BASE (NÃO COPIAR IGUAL, MAS MANTER O CLIMA):
"${baseTemplate}"

REGRAS:
- 2 a 3 frases no máximo.
- Tom leve, humano, nada robótico.
- Tratar o lead pelo primeiro nome.
- Se houver contexto de valores, mencionar de forma suave que está vendo se conseguiu analisar os valores.
- Em todos os casos, oferecer ajuda + possibilidade de enviar horários disponíveis para avaliação.
- Exatamente 1 💚 na mensagem inteira.
- Pode usar 1 ou 2 emojis leves (😊, ✨), sem exagero.
- NÃO insista demais, é um lembrete educado, não cobrança.
`.trim();

    try {
        const resp = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 200,
            temperature: 0.7,
            system: SYSTEM_PROMPT_AMANDA,
            messages: [
                {
                    role: "user",
                    content: userPrompt,   // 👉 agora usa o prompt completo
                },
            ],
        });

        const text = (resp.content?.[0]?.text || "").trim();

        // Se por algum motivo vier vazio, usa o template que você ama
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

/* =========================================================================
   🛠️ HELPERS
   ========================================================================= */
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, "").trim();
    return `${clean} 💚`;
}

// Exporta CLINIC_ADDRESS e SYSTEM_PROMPT_AMANDA para compatibilidade
export { CLINIC_ADDRESS, SYSTEM_PROMPT_AMANDA };
