// src/services/amandaService.js
// Serviço que consome os PROMPTS padronizados da Amanda (NOMES ESTÁVEIS)

import axios from "axios";
import OpenAI from "openai";
import { Readable } from "stream";
import {
    CLINIC_ADDRESS,
    POLICY_RULES,
    SYSTEM_PROMPT_AMANDA,
    buildUserPromptWithValuePitch,
} from "../utils/amandaPrompt.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================================
   Utils de pós-processamento (garantias de formato)
   ========================================================================= */
function stripLinks(text = "") {
    // remove URLs explícitas (evitamos links)
    return text.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}

function clampTo1to3Sentences(text = "") {
    const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const out = parts.slice(0, 3).join(" ").trim();
    return out || text.trim();
}

function ensureSingleHeartAtEnd(text = "") {
    // remove todos os corações, depois põe um no final
    const noHearts = text.replace(/💚/g, "").trim();
    return `${noHearts} 💚`.replace(/\s{2,}/g, " ").trim();
}

/* =========================================================================
   1) Follow-up curto (reengajar leads)
   ========================================================================= */
function personalizeIntro(origin = "") {
    const o = (origin || "").toLowerCase();
    if (o.includes("google")) return "Vimos seu contato pelo Google e ficamos felizes em ajudar. ";
    if (o.includes("instagram") || o.includes("facebook") || o.includes("meta"))
        return "Recebemos sua mensagem pelo Instagram, que bom falar com você! ";
    if (o.includes("indica")) return "Agradecemos a indicação! ";
    return "";
}

export async function generateFollowupMessage(lead = {}) {
    const name = lead?.name?.split(" ")[0] || "tudo bem";
    const reason = lead?.reason || "avaliação/terapia";
    const origin = lead?.origin || "WhatsApp";
    const lastInteraction = lead?.lastInteraction || "há alguns dias";

    const system = SYSTEM_PROMPT_AMANDA;

    const user = `
Gere uma mensagem curta de follow-up para ${name}.
Contexto:
- Origem: ${origin}
- Motivo do contato: ${reason}
- Última interação: ${lastInteraction}
Objetivo: reengajar e facilitar o agendamento.
Regras:
- Use exatamente 1 emoji 💚 (obrigatório, no final).
- Ofereça no máximo 2 janelas de horário, se fizer sentido (sem inventar datas específicas).
- Termine com: "Posso te ajudar a agendar agora?".
Texto-base (se útil): ${personalizeIntro(origin)}
`.trim();

    try {
        let resp;
        try {
            resp = await openai.chat.completions.create({
                model: "gpt-5-mini",
                temperature: 0.7,
                max_tokens: 140,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
            });
        } catch {
            resp = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: 0.7,
                max_tokens: 140,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
            });
        }

        let out =
            resp.choices?.[0]?.message?.content?.trim() ||
            `Oi ${name}, tudo bem? Podemos retomar sobre ${reason}. Temos horários flexíveis. Posso te ajudar a agendar agora?`;

        // Garantias finais
        out = stripLinks(out);
        out = clampTo1to3Sentences(out);
        out = ensureSingleHeartAtEnd(out);

        return out;
    } catch {
        const fallback = `Oi ${name}, tudo bem? Passando para saber se posso te ajudar com ${reason}. Temos horários flexíveis nesta semana. Posso te ajudar a agendar agora?`;
        return ensureSingleHeartAtEnd(fallback);
    }
}

/* =========================================================================
   2) Resposta conversacional (webhook/chat) com “Valor → Preço”
   flags: {
     text, name?, origin?, topic?, asksPrice?, insistsPrice?,
     wantsSchedule?, asksAddress?, asksPayment?, asksHours?, asksPlans?
   }
   ========================================================================= */
export async function generateAmandaReply(flags = {}) {
    const user = buildUserPromptWithValuePitch(flags);

    let resp;
    try {
        resp = await openai.chat.completions.create({
            model: "gpt-5-mini",
            temperature: 0.5,
            max_tokens: 220,
            messages: [
                { role: "system", content: SYSTEM_PROMPT_AMANDA },
                { role: "user", content: user },
            ],
        });
    } catch {
        resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.5,
            max_tokens: 220,
            messages: [
                { role: "system", content: SYSTEM_PROMPT_AMANDA },
                { role: "user", content: user },
            ],
        });
    }

    let out = resp.choices?.[0]?.message?.content?.trim() || "";

    // Garantias finais
    out = stripLinks(out);
    out = clampTo1to3Sentences(out);
    out = ensureSingleHeartAtEnd(out);

    // Se perguntaram por endereço e a resposta não citou nada, reforça (sem quebrar o formato)
    if (flags.asksAddress && !/Anápolis|Minas Gerais/i.test(out)) {
        out = `${out}\n\n${CLINIC_ADDRESS}`;
    }

    return out;
}

/* =========================================================================
   3) Áudio → texto (Whisper)
   ========================================================================= */
export async function transcribeWaAudioFromGraph({ mediaUrl, fileName = "audio.ogg" } = {}) {
    try {
        const { data } = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            timeout: 20000,
        });
        const buffer = Buffer.from(data);

        // Node: passe um Readable com filename para o SDK
        const stream = Readable.from(buffer);
        // atribuímos um nome para o multipart
        stream.path = fileName;

        const resp = await openai.audio.transcriptions.create({
            file: stream, // stream + .path para nome do arquivo
            model: "whisper-1", // estável p/ OGG/opus
            language: "pt",
            temperature: 0.2,
        });

        return (resp?.text || "").trim();
    } catch (e) {
        console.error("❌ transcribeWaAudioFromGraph:", e?.message || e);
        return "";
    }
}

/* =========================================================================
   4) Descrição de imagem (curta)
   ========================================================================= */
export async function describeWaImageFromGraph({ imageUrl, caption = "" } = {}) {
    try {
        const resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.4,
            max_tokens: 160,
            messages: [
                {
                    role: "system",
                    content:
                        "Você é a Amanda 💚, assistente da Clínica Fono Inova. Descreva brevemente a imagem em 1–2 frases, sem inventar, em pt-BR. Se não for possível entender, diga que verificará.",
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Legenda do cliente: ${caption || "(sem legenda)"}` },
                        { type: "image_url", image_url: { url: imageUrl } },
                    ],
                },
            ],
        });

        let out = (resp.choices?.[0]?.message?.content || "").trim();
        out = stripLinks(out);
        out = clampTo1to3Sentences(out);
        // aqui não forçamos 💚 porque é uma descrição técnica curta
        return out;
    } catch (e) {
        console.error("❌ describeWaImageFromGraph:", e?.message || e);
        return "";
    }
}

/* =========================================================================
   Export auxiliar (caso o back precise das regras/endereço em outro ponto)
   ========================================================================= */
export { CLINIC_ADDRESS, POLICY_RULES, SYSTEM_PROMPT_AMANDA };
