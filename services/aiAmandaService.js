import axios from "axios";
import OpenAI from "openai";
import { Readable } from "stream";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
   Políticas/valores da clínica
   ========================= */
const POLICY = `
• Não atendemos convênios/planos de saúde no momento (estamos em credenciamento).
• Avaliação inicial: R$ 200 (promo CDL) ou R$ 250 valor normal.
• Sessão avulsa: R$ 220.
• Pacote mensal (1x/semana): R$ 180 cada (≈ R$ 720/mês).
• Só ofereça horários quando o cliente pedir para agendar.
• Se precisar confirmar algo, diga: "Vou verificar e já te retorno, por favor um momento 💚".
`.trim();

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
Estilo: acolhedor, claro, proativo e curto (2–4 frases). SEM links. Use exatamente 1 💚.
Assine como "Equipe Fono Inova 💚".
Idioma: pt-BR.
${POLICY}
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
        const out = text || `Oi ${name}, tudo bem? Podemos retomar sobre ${reason}. Temos horários flexíveis. Posso te ajudar a agendar agora? 💚`;
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

    const text = (userText || "").trim();
    const wantsSchedule = RE_SCHEDULE.test(text);
    const asksPrice = RE_PRICE.test(text);
    const asksAddress = RE_ADDRESS.test(text);
    const asksPayment = RE_PAYMENT.test(text);
    const asksHours = RE_HOURS.test(text);

    const lastMsgs = Array.isArray(context?.lastMessages) ? context.lastMessages.slice(-5) : [];
    const isFirstContact = !!context?.isFirstContact || lastMsgs.length === 0 || RE_GREET.test(text);

    const system = `
Você é a Amanda 💚, assistente da Clínica Fono Inova (Anápolis-GO).
Estilo: acolhedor, claro, proativo e curto (2–4 frases). SEM links. Use exatamente 1 💚.
Assine como "Equipe Fono Inova 💚".
Idioma: pt-BR.
Nunca invente horários/valores. Se precisar confirmar algo: "Vou verificar e já te retorno, por favor um momento 💚".
Regras comerciais:
${POLICY}
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
- 2–4 frases; 1 💚; finalize convidando a pessoa a dizer a necessidade.
`.trim()
        : `
Contexto: conversa em andamento.
Mensagem do cliente: """${text}"""
Lead: nome=${name || "(desconhecido)"}; motivo=${reason}; origem=${origin}
Sinais: wantsSchedule=${wantsSchedule}; asksPrice=${asksPrice}; asksAddress=${asksAddress}; asksPayment=${asksPayment}; asksHours=${asksHours}

Objetivo:
- Responda objetivamente.
- Se pedirem valores: use os valores da política (avaliação R$250 CDL / R$300, sessão R$220, pacote R$180).
- Se pedirem endereço/horário/pagamento e você não tiver 100% de certeza: diga "Vou verificar e já te retorno, por favor um momento 💚"
  e faça 1 pergunta objetiva para avançar.
- Só ofereça horários se wantsSchedule=true; ofereça no máximo 2 opções objetivas.
Regras:
- 2–4 frases, 1 💚, final propositivo.
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

        // Bloquear oferta de horários se o cliente não pediu agendamento
        if (!isFirstContact && !wantsSchedule) {
            out = out
                .replace(/\b(amanh[aã]|hoje|segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo)\b[^.!\n]{0,60}\b(\d{1,2}h(\d{2})?)\b/gi, "")
                .replace(/\b(\d{1,2}\s*h(\s*\d{2})?)\b/gi, "")
                .replace(/\b(op[cç][aã]o|hor[áa]rio)s?:?[^.!\n]+/gi, "")
                .replace(/\s{2,}/g, " ")
                .trim();
        }

        if (!out.includes("💚")) out += " 💚";
        if (!/Equipe Fono Inova 💚$/m.test(out.trim())) out += `\n\nEquipe Fono Inova 💚`;

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
export async function transcribeWaAudioFromGraph({ mediaUrl, fileName = "audio.ogg" }) {
    try {
        const { data } = await axios.get(mediaUrl, { responseType: "arraybuffer", timeout: 20000 });
        const buffer = Buffer.from(data);

        // Node: passe um Readable com filename para o SDK
        const stream = Readable.from(buffer);
        // @ts-ignore – atribuímos um nome para o multipart
        stream.path = fileName;

        const resp = await openai.audio.transcriptions.create({
            file: stream,         // stream + .path para nome do arquivo
            model: "whisper-1",   // estável p/ OGG/opus
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
                        "Você é a Amanda 💚, assistente da Clínica Fono Inova. Descreva brevemente a imagem em 1–2 frases, sem inventar, em pt-BR. Se não for possível entender, diga que verificará."
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Legenda do cliente: ${caption || "(sem legenda)"}` },
                        { type: "image_url", image_url: { url: imageUrl } },
                    ]
                }
            ]
        });

        return (resp.choices?.[0]?.message?.content || "").trim();
    } catch (e) {
        console.error("❌ describeWaImageFromGraph:", e.message);
        return "";
    }
}
