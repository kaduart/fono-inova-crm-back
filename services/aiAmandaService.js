import axios from "axios";
import OpenAI from "openai";
import { Readable } from "stream";
import { POLICY_RULES } from "../utils/amandaPrompt";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
   Detectores
   ========================= */
const RE_PLANS = /\b(ipasgo|unimed|amil|bradesco|sul\s*américa|sulamerica|hapvida|assim|golden\s*cross|notre\s*dame|interm[eé]dica|intermedica|base|plano[s]?|conv[eê]nio[s]?)\b/i;
const RE_CDL = /\bcdl\b/i;
const RE_SESSION = /\b(sess[aã]o|avulsa|por\s*sess[aã]o)\b/i;
const RE_PACKAGE = /\b(pacote|mensal|plano\s*mensal)\b/i;

/* =========================
   1) Follow-up curto (rota /draft etc.)
   ========================= */
function personalizeIntro(origin = "") {
    const o = (origin || "").toLowerCase();
    if (o.includes("google")) return "Vimos seu contato pelo Google e ficamos felizes em ajudar. ";
    if (o.includes("instagram") || o.includes("facebook") || o.includes("meta"))
        return "Recebemos sua mensagem pelo Instagram, que bom falar com você! ";
    if (o.includes("indica")) return "Agradecemos a indicação! ";
    return "";
}

export async function generateFollowupMessage(lead) {
    const name = lead?.name?.split(" ")[0] || "tudo bem";
    const reason = lead?.reason || "avaliação/terapia";
    const origin = lead?.origin || "WhatsApp";

    const system = `
Você é a Amanda 💚, assistente da Clínica Fono Inova (Anápolis-GO).
Estilo: acolhedor, claro e curto (1–3 frases). SEM links. Use exatamente 1 💚.
Idioma: pt-BR.
${POLICY_RULES}
`.trim();

    const user = `
${personalizeIntro(origin)}Gere uma mensagem curta de follow-up para ${name}.
Contexto:
- Origem: ${origin}
- Motivo do contato: ${reason}
- Última interação: ${lead?.lastInteraction || "há alguns dias"}
Objetivo: reengajar e facilitar o agendamento.
Regras:
- Use exatamente 1 emoji 💚 (obrigatório).
- Ofereça no máximo 2 janelas de horário, se fizer sentido.
- Termine com: "Posso te ajudar a agendar agora?".
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

        const text = resp.choices?.[0]?.message?.content?.trim();
        const out =
            text ||
            `Oi ${name}, tudo bem? Podemos retomar sobre ${reason}. Temos horários flexíveis. Posso te ajudar a agendar agora? 💚`;
        return out.includes("💚") ? out : `${out} 💚`;
    } catch {
        return `Oi ${name}, tudo bem? Passando para saber se posso te ajudar com ${reason}. Temos horários flexíveis nesta semana. Posso te ajudar a agendar agora? 💚`;
    }
}

/* =========================
   2) Resposta conversacional (webhook/chat)
   ========================= */
const RE_SCHEDULE = /\b(agendar|marcar|marcação|agenda|hor[aá]rio|consulta|agendamento)\b/i;
const RE_PRICE = /\b(pre[cç]o|valor|custa|quanto|mensal|pacote|planos?)\b/i;
const RE_ADDRESS = /\b(endere[cç]o|local|onde fica|mapa)\b/i;
const RE_PAYMENT = /\b(pagamento|pix|cart[aã]o|dinheiro|cr[eé]dito|d[eé]bito)\b/i;
const RE_HOURS = /\b(hor[áa]rio[s]? de atendimento|abre|fecha|funcionamento)\b/i;
const RE_GREET = /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|tudo\s*bem|bom\s*dia|fala|e[aíi])[\s!,.]*$/i;

export async function generateAmandaReply({ userText, lead = {}, context = {} }) {
    const name = (lead?.name || "").split(" ")[0] || "";
    const reason = lead?.reason || "avaliação/terapia";
    const origin = lead?.origin || "WhatsApp";

    const text = (userText || "").trim(); // <- definir antes de usar
    const wantsSchedule = RE_SCHEDULE.test(text);
    const asksPrice = RE_PRICE.test(text);
    const asksAddress = RE_ADDRESS.test(text);
    const asksPayment = RE_PAYMENT.test(text);
    const asksHours = RE_HOURS.test(text);
    const asksPlans = RE_PLANS.test(text); // <- agora correto (após text)

    const lastMsgs = Array.isArray(context?.lastMessages)
        ? context.lastMessages.slice(-5)
        : [];
    const isFirstContact =
        !!context?.isFirstContact || lastMsgs.length === 0 || RE_GREET.test(text);

    const system = `
Você é a Amanda 💚, assistente da Clínica Fono Inova (Anápolis-GO).
Estilo: acolhedor, claro e curto (1–3 frases). SEM links. Use exatamente 1 💚.
Assine como "Equipe Fono Inova 💚".
Idioma: pt-BR.
Nunca invente horários/valores. Se precisar confirmar algo: "Vou verificar e já te retorno, por favor um momento 💚".
Regras comerciais:
${POLICY_RULES}
`.trim();

    const userPrompt = isFirstContact
        ? `
Contexto: primeiro contato (saudação/abertura).
Mensagem do cliente: """${text}"""

Objetivo:
1) Cumprimente (use o nome se souber).
2) Pergunte no que pode ajudar.
3) Se fizer sentido, ofereça 2 caminhos simples (avaliação ou tirar dúvidas).
4) NÃO ofereça horários agora.
Regras:
- 1–3 frases; 1 💚; finalize convidando a pessoa a dizer a necessidade.
`.trim()
        : `
Contexto: conversa em andamento.
Mensagem do cliente: """${text}"""
Lead: nome=${name || "(desconhecido)"}; motivo=${reason}; origem=${origin}
Sinais: wantsSchedule=${wantsSchedule}; asksPrice=${asksPrice}; asksAddress=${asksAddress}; asksPayment=${asksPayment}; asksHours=${asksHours}; asksPlans=${asksPlans}

Objetivo:
- Responda objetivamente em 1–3 frases.
- Se asksPlans=true: diga que estamos em credenciamento e que atendemos particular (avaliação R$ 220).
- Se pedirem valores:
  • Se mencionar “CDL”: avaliação R$ 200 (CDL).
  • Se perguntar sobre “sessão”: “Sessão individual R$ 220; no pacote mensal sai por R$ 180 por sessão (~R$ 720/mês)”.
  • Se perguntar sobre “pacote”: explique o pacote (R$ 180/sessão, ~R$ 720/mês).
  • Se for genérico (“preço/valor?”): responda só avaliação particular R$ 220.
- Se pedirem endereço/horário/pagamento e você não tiver 100% de certeza: diga “Vou verificar e já te retorno, por favor um momento 💚” e faça 1 pergunta objetiva.
- Só ofereça horários se wantsSchedule=true; ofereça no máximo 2 opções objetivas.

Regras:
- 1–3 frases, 1 💚, final propositivo; assine “Equipe Fono Inova 💚”.
- Não citar CDL se o cliente não mencionar.
- Não citar pacote se o cliente não mencionar (exceto na resposta sobre “sessão”, onde a comparação é permitida).
`.trim();

    try {
        let resp;
        try {
            resp = await openai.chat.completions.create({
                model: "gpt-5-mini",
                temperature: isFirstContact ? 0.7 : 0.5,
                max_tokens: 180,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: userPrompt },
                ],
            });
        } catch {
            resp = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: isFirstContact ? 0.7 : 0.5,
                max_tokens: 180,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: userPrompt },
                ],
            });
        }

        let out = resp?.choices?.[0]?.message?.content?.trim() || "";

        /* ========= PÓS-PROCESSAMENTO (garantias) ========= */

        // 0) Resposta de planos/convênios (qualquer plano -> curto e padrão)
        if (!isFirstContact && asksPlans) {
            out =
                "Estamos em fase de credenciamento para planos/convênios. No momento atendemos particular: avaliação R$ 220. Posso te ajudar a agendar? 💚";
        }

        // 1) Bloquear oferta de horários se o cliente não pediu agendamento
        if (!isFirstContact && !wantsSchedule) {
            out = out
                .replace(
                    /\b(amanh[aã]|hoje|segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo)\b[^.!\n]{0,60}\b(\d{1,2}h(\d{2})?)\b/gi,
                    ""
                )
                .replace(/\b(\d{1,2}\s*h(\s*\d{2})?)\b/gi, "")
                .replace(/\b(op[cç][aã]o|hor[áa]rio)s?:?[^.!\n]+/gi, "")
                .replace(/\s{2,}/g, " ")
                .trim();
        }

        // 2) Remover CDL se o cliente não falou CDL
        const mentionsCDL = RE_CDL.test(text);
        if (!mentionsCDL) {
            out = out.replace(/\bcdl\b[^.!?\n]*?/gi, "").replace(/\s{2,}/g, " ").trim();
        }

        // 3) Pacote só quando perguntar por pacote OU sessão (comparação permitida em sessão)
        const mentionsSession = RE_SESSION.test(text);
        const mentionsPackage = RE_PACKAGE.test(text);
        const canMentionPackage = mentionsPackage || mentionsSession;
        if (!canMentionPackage) {
            out = out
                .replace(/\b(pacote|mensal|plano\s*mensal)[^.!?\n]*[.!?]/gi, "")
                .replace(/\s{2,}/g, " ")
                .trim();
        }

        // 4) Se perguntou sessão, garantir comparação 220 vs 180
        if (asksPrice && mentionsSession && !/R\$?\s*220/i.test(out)) {
            const base =
                "Sessão individual é R$ 220; no pacote mensal sai por R$ 180 por sessão (~R$ 720/mês).";
            out = out ? `${out} ${base}` : base;
        }

        // 5) Limitar a 1–3 frases
        out = out.split(/(?<=[.!?])\s+/).slice(0, 3).join(" ").trim();

        // 6) Garantir 💚 e assinatura
        if (!out.includes("💚")) out += " 💚";
        if (!/Equipe Fono Inova 💚$/m.test(out.trim()))
            out += `\n\nEquipe Fono Inova 💚`;

        // 7) Fallbacks curtinhos
        if (!out.trim()) {
            out = isFirstContact
                ? `Oi${name ? `, ${name}` : ""}! Sou a Amanda da Fono Inova. Em que posso te ajudar hoje? 💚\n\nEquipe Fono Inova 💚`
                : `Vou verificar e já te retorno, por favor um momento 💚 Qual período fica melhor para você (manhã ou tarde)?\n\nEquipe Fono Inova 💚`;
        }

        return out;
    } catch {
        return isFirstContact
            ? `Oi${name ? `, ${name}` : ""}! Sou a Amanda da Fono Inova. Em que posso te ajudar hoje? 💚\n\nEquipe Fono Inova 💚`
            : `Vou verificar e já te retorno, por favor um momento 💚 Qual período fica melhor para você (manhã ou tarde)?\n\nEquipe Fono Inova 💚`;
    }
}

/* =========================
   3) Áudio → texto (Whisper)
   ========================= */
export async function transcribeWaAudioFromGraph({
    mediaUrl,
    fileName = "audio.ogg",
}) {
    try {
        const { data } = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            timeout: 20000,
        });
        const buffer = Buffer.from(data);

        // Node: passe um Readable com filename para o SDK
        const stream = Readable.from(buffer);
        // @ts-ignore – atribuímos um nome para o multipart
        stream.path = fileName;

        const resp = await openai.audio.transcriptions.create({
            file: stream, // stream + .path para nome do arquivo
            model: "whisper-1", // estável p/ OGG/opus
            language: "pt",
            temperature: 0.2,
        });

        return (resp?.text || "").trim();
    } catch (e) {
        console.error("❌ transcribeWaAudioFromGraph:", e.message);
        return "";
    }
}

/* =========================
   4) Descrição de imagem (curta)
   ========================= */
export async function describeWaImageFromGraph({ imageUrl, caption = "" }) {
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

        return (resp.choices?.[0]?.message?.content || "").trim();
    } catch (e) {
        console.error("❌ describeWaImageFromGraph:", e.message);
        return "";
    }
}
