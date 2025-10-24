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

// (adicione abaixo dos imports)
const RE_ADDR = /\b(onde\s+fica|endere[cç]o|endereco|local|localiza[cç][aã]o|mapa|como\s+chegar)\b/i;
const RE_PRICE = /\b(pre[çc]o|valor|custa|quanto|mensal|pacote|sess(ão|ao))\b/i;
const RE_PLANS = /\b(ipasgo|unimed|amil|bradesco|sul\s*am[eé]rica|sulamerica|hapvida|assim|golden\s*cross|notre\s*dame|interm[eé]dica|intermedica|conv[eê]nio|planos?)\b/i;
const RE_SCHEDULE = /\b(agendar|marcar|marca[çc][aã]o|agenda|hor[áa]rio|consulta|agendamento)\b/i;
const RE_HOURS = /\b(hor[áa]rio[s]?\s*de\s*atendimento|abre|fecha|funcionamento)\b/i;
const RE_PAYMENT = /\b(pagamento|pix|cart[aã]o|cr[eé]dito|d[eé]bito|dinheiro)\b/i;
const RE_PSY_CHILD = /\b(psicolog[oa]\s*(infantil|p(?:ara)?\s*crian[cç]as?|pedi[aá]trico))\b/i;

// helper para deduzir flags quando só vem "text"
function deriveFlagsFromText(raw = "", lead = {}) {
    const text = String(raw || "");
    return {
        text,
        name: lead?.name,
        origin: lead?.origin,
        asksAddress: RE_ADDR.test(text),
        asksPrice: RE_PRICE.test(text),
        asksPlans: RE_PLANS.test(text),
        wantsSchedule: RE_SCHEDULE.test(text),
        asksHours: RE_HOURS.test(text),
        asksPayment: RE_PAYMENT.test(text),
        // tópico “rápido” se pedirem psicólogo infantil explicitamente
        topic: RE_PSY_CHILD.test(text) ? "psicologia" : undefined,
    };
}

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
    // se só vier { text }, enriquecemos com flags inferidas
    const inferred = deriveFlagsFromText(flags.text || "", flags);
    const merged = { ...inferred, ...flags };

    // --- curto-circuitos determinísticos (evita resposta genérica) ---
    // 1) Endereço direto
    if (merged.asksAddress && !merged.text.match(/\b(rota|estacionamento|como chegar)\b/i)) {
        // mensagem curtinha e objetiva + 1 pergunta de avanço
        return ensureSingleHeartAtEnd(
            `Estamos na ${CLINIC_ADDRESS}. Prefere que eu envie a localização pelo mapa para facilitar?`
        );
    }

    // 2) Psicólogo infantil (valor→preço só se pedirem preço)
    if (RE_PSY_CHILD.test(merged.text)) {
        const pitch = "Temos psicologia infantil com abordagem baseada em evidências para regulação emocional, comportamento e desenvolvimento.";
        const priceLine = merged.asksPrice ? "A avaliação inicial é R$ 220." : "";
        const tail = "Posso te ajudar a agendar ou prefere tirar uma dúvida rápida?";
        return ensureSingleHeartAtEnd([pitch, priceLine, tail].filter(Boolean).join(" "));
    }

    // --- prompt completo com Valor→Preço (do arquivo utils) ---
    const user = buildUserPromptWithValuePitch(merged);

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

    // reforço de endereço se perguntaram e o modelo não trouxe
    if (merged.asksAddress && !/Anápolis|Minas Gerais/i.test(out)) {
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
