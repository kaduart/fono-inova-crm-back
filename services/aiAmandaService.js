// services/aiAmandaService.js - VERSÃO SIMPLIFICADA (80% MENOS CÓDIGO)

import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import OpenAI from "openai";
import { Readable } from "stream";
import getOptimizedAmandaResponse from "../utils/amandaOrchestrator.js";

import { CLINIC_ADDRESS, SYSTEM_PROMPT_AMANDA } from "../utils/amandaPrompt.js";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* =========================================================================
   🎯 FUNÇÃO PRINCIPAL - USA O ORCHESTRATOR
   ========================================================================= */
export async function generateAmandaReply({ userText, lead = {}, context = {} }) {
    try {
        // 🚀 DELEGA TUDO PARA O ORCHESTRATOR
        const response = await getOptimizedAmandaResponse({
            content: userText,
            userText,
            lead,
            context
        });

        console.log("[AmandaReply] Resposta gerada:", response);
        return response;

    } catch (error) {
        console.error("❌ Erro em generateAmandaReply:", error);
        return "Vou verificar e já te retorno, por favor um momento 💚";
    }
}

/* =========================================================================
   📞 FOLLOW-UP (MANTIDO)
   ========================================================================= */
export async function generateFollowupMessage(lead) {
    const name = lead?.name?.split(" ")[0] || "tudo bem";
    const reason = lead?.reason || "avaliação/terapia";
    const origin = lead?.origin || "WhatsApp";

    const userPrompt = `
Gere uma mensagem curta de follow-up para ${name}.
Contexto:
- Origem: ${origin}
- Motivo: ${reason}
- Última interação: ${lead?.lastInteraction || "há alguns dias"}

REGRAS:
• 2-3 frases máximo
• Tom amigável e não invasivo
• Exatamente 1 💚 no final
• Termine com pergunta sobre agendamento

Exemplo: "Oi ${name}! Passando pra saber se posso te ajudar com ${reason}. Temos horários flexíveis esta semana. Posso te ajudar a agendar? 💚"
`.trim();

    try {
        const resp = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 150,
            temperature: 0.7,
            system: SYSTEM_PROMPT_AMANDA,
            messages: [{
                role: "user",
                content: `Gere follow-up curto para ${name}. Motivo: ${reason}. 2-3 frases. 1 💚 no final.`
            }]
        });

        const text = resp.content[0]?.text || `Oi ${name}! Posso te ajudar? 💚`;
        return ensureSingleHeart(text);
    } catch (error) {
        console.error("❌ Erro ao gerar follow-up:", error);
        return `Oi ${name}! Passando pra saber se posso te ajudar com o agendamento 💚`;
    }
}

/* =========================================================================
   🎙️ TRANSCRIÇÃO DE ÁUDIO (MANTIDO)
   ========================================================================= */
export async function transcribeWaAudioFromGraph({ mediaUrl, fileName = "audio.ogg" } = {}) {
    try {
        const { data } = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            timeout: 20000
        });

        const buffer = Buffer.from(data);
        const stream = Readable.from(buffer);
        stream.path = fileName;

        const resp = await openai.audio.transcriptions.create({
            file: stream,
            model: "whisper-1",
            language: "pt",
            temperature: 0.2
        });

        return (resp?.text || "").trim();
    } catch (error) {
        console.error("❌ Erro ao transcrever áudio:", error.message);
        return "";
    }
}

/* =========================================================================
   🖼️ DESCRIÇÃO DE IMAGEM (MANTIDO)
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
                    content: "Você é a Amanda da Clínica Fono Inova. Descreva brevemente a imagem em 1-2 frases, em pt-BR."
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Legenda: ${caption || "(sem legenda)"}` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ]
        });

        return (resp.choices?.[0]?.message?.content || "").trim();
    } catch (error) {
        console.error("❌ Erro ao descrever imagem:", error.message);
        return "";
    }
}

/* =========================================================================
   🛠️ HELPERS
   ========================================================================= */
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, '').trim();
    return `${clean} 💚`;
}

// Exporta CLINIC_ADDRESS para compatibilidade
export { CLINIC_ADDRESS, SYSTEM_PROMPT_AMANDA };
