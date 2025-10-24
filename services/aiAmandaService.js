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
    return text.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}
function clampTo1to3Sentences(text = "") {
    const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const out = parts.slice(0, 3).join(" ").trim();
    return out || text.trim();
}
function ensureSingleHeartAtEnd(text = "") {
    const noHearts = text.replace(/💚/g, "").trim();
    return `${noHearts} 💚`.replace(/\s{2,}/g, " ").trim();
}

/* =========================================================================
   0) Derivador de FLAGS a partir do texto (essencial p/ o prompt rico)
   ========================================================================= */
function deriveFlagsFromText(text = "") {
    const t = (text || "").toLowerCase();

    const RE_SCHEDULE = /\b(agend(ar|o|a|amento)|marcar|marcação|agenda|hor[áa]rio|consulta)\b/;
    const RE_PRICE = /\b(preç|preco|preço|valor|custa|quanto|mensal|pacote|planos?)\b/;
    const RE_ADDRESS = /\b(endere[cç]o|end.|localiza(c|ç)(a|ã)o|onde fica|mapa|como chegar)\b/;
    const RE_PAYMENT = /\b(pagamento|pix|cart(ão|ao)|dinheiro|cr[eé]dito|d[eé]bito)\b/;
    const RE_HOURS = /\b(hor[áa]ri(o|os) de atendimento|abre|fecha|funcionamento)\b/;
    const RE_PLANS = /\b(ipasgo|unimed|amil|bradesco|sul\s*am(e|é)rica|hapvida|assim|golden\s*cross|notre\s*dame|interm(e|é)dica|plano[s]?|conv(e|ê)nio[s]?)\b/;
    const RE_INSIST_PRICE = /(só|so|apenas)\s*(o|a)?\s*pre(ç|c)o|fala\s*o\s*valor|me\s*diz\s*o\s*pre(ç|c)o/;
    const RE_CHILD_PSY = /\b(psic(o|ó)logo infantil|psicologia infantil|psic(o|ó)loga infantil)\b/;

    return {
        asksPrice: RE_PRICE.test(t),
        insistsPrice: RE_INSIST_PRICE.test(t),
        wantsSchedule: RE_SCHEDULE.test(t),
        asksAddress: RE_ADDRESS.test(t),
        asksPayment: RE_PAYMENT.test(t),
        asksHours: RE_HOURS.test(t),
        asksPlans: RE_PLANS.test(t),
        asksChildPsychology: RE_CHILD_PSY.test(t),
    };
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

        out = stripLinks(out);
        out = clampTo1to3Sentences(out);
        out = ensureSingleHeartAtEnd(out);

        return out;
    } catch {
        const fallback = `Oi ${name}, tudo bem? Passando para saber se posso te ajudar com ${reason}. Temos horários flexíveis nesta semana. Posso te ajudar a agendar agora?`;
        return ensureSingleHeartAtEnd(fallback);
    }
}

export async function generateAmandaReply({ userText, lead = {}, context = {} }) {
    // 🔍 2.1 Converter parâmetros antigos para o novo formato de flags
    const text = userText || "";
    const name = lead?.name || "";
    const origin = lead?.origin || "WhatsApp";
    const reason = lead?.reason || "avaliação/terapia";

    // 🔍 2.2 Deriva flags do texto
    const derivedFlags = deriveFlagsFromText(text);

    // 🔍 2.3 Determinar se é primeiro contato (usando o contexto)
    const lastMsgs = Array.isArray(context?.lastMessages) ? context.lastMessages.slice(-5) : [];
    const greetings = /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|tudo\s*bem|bom\s*dia|fala|e[aíi])[\s!,.]*$/i;
    const isFirstContact =
        !!context?.isFirstContact ||
        lastMsgs.length === 0 ||
        greetings.test(text.trim());

    // 🔍 2.4 Montar objeto de flags completo
    const flags = {
        text,
        name,
        origin,
        reason,
        isFirstContact,
        ...derivedFlags
    };

    // 🔍 2.5 Curto-circuitos úteis (garantem resposta certeira):

    // Endereço direto
    if (flags.asksAddress) {
        const msg = `Estamos na ${CLINIC_ADDRESS}. Prefere que eu te envie a localização pelo mapa?`;
        return ensureSingleHeartAtEnd(clampTo1to3Sentences(stripLinks(msg)));
    }

    // Psicólogo infantil direto
    if (flags.asksChildPsychology) {
        const msg = "Temos psicologia infantil com foco em desenvolvimento emocional e comportamental (TCC e intervenções para neurodesenvolvimento). Posso te ajudar com a avaliação inicial?";
        return ensureSingleHeartAtEnd(clampTo1to3Sentences(stripLinks(msg)));
    }

    // 🔍 2.6 Monta o prompt rico com as flags corretas
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

    // 🔍 2.7 Garantias finais de formato
    out = stripLinks(out);
    out = clampTo1to3Sentences(out);
    out = ensureSingleHeartAtEnd(out);

    console.log("🔍 [Amanda Debug] Flags detectadas:", {
        text: text.substring(0, 100),
        name,
        origin,
        isFirstContact,
        derivedFlags,
        fullFlags: flags
    });

    console.log("🔍 [Amanda Debug] Prompt enviado para OpenAI:", user);
    // 🔍 2.8 Se perguntaram endereço e o modelo não citou, adiciona de forma elegante
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

        const stream = Readable.from(buffer);
        stream.path = fileName; // nome do arquivo no multipart

        const resp = await openai.audio.transcriptions.create({
            file: stream,
            model: "whisper-1",
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
        return out; // sem 💚 aqui (descrição técnica)
    } catch (e) {
        console.error("❌ describeWaImageFromGraph:", e?.message || e);
        return "";
    }
}

/* =========================================================================
   Export auxiliar (caso o back precise das regras/endereço em outro ponto)
   ========================================================================= */
export { CLINIC_ADDRESS, POLICY_RULES, SYSTEM_PROMPT_AMANDA };
