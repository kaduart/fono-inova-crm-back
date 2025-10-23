// services/aiAmanda.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Estilo base da Amanda ===
const baseStyle = `
Você é a Amanda 💚, assistente da Clínica Fono Inova (Anápolis-GO).
Estilo: acolhedor, claro, proativo e curto (2–4 frases). SEM links. Use exatamente 1 💚.
Assine como "Equipe Fono Inova 💚".
Idioma: pt-BR.
Tópicos: fonoaudiologia, avaliação, terapia, agendamentos, valores, endereços e horários.
Se a pergunta exigir confirmação de agenda/valor/endereço específico, diga:
"Vou verificar e já te retorno, por favor um momento 💚" e faça 1 pergunta objetiva para seguir.
Jamais invente preços/horários. Se não souber, assuma e peça um instante.
Quando oferecer horários, dê no máximo 2 opções objetivas (ex.: amanhã 9h ou sexta 15h).
Sempre terminar convidando a continuar (ex.: "Posso te ajudar a agendar agora?").
`;

// ——— personalização simples de origem para follow-up
function personalizeIntro(origin = "") {
    const o = (origin || "").toLowerCase();
    if (o.includes("google")) return "Vimos seu contato pelo Google e ficamos felizes em ajudar. ";
    if (o.includes("instagram") || o.includes("facebook") || o.includes("meta"))
        return "Recebemos sua mensagem pelo Instagram, que bom falar com você! ";
    if (o.includes("indica")) return "Agradecemos a indicação! ";
    return "";
}

// ======================================================
// 1) Follow-up curto e propositivo (mantém sua rota /draft)
// ======================================================
export async function generateFollowupMessage(lead) {
    const name = lead?.name?.split(" ")[0] || "tudo bem";
    const reason = lead?.reason || "avaliação/terapia";
    const origin = lead?.origin || "WhatsApp";

    const system = baseStyle.trim();
    const intro = personalizeIntro(origin);

    const user = `
Gere uma mensagem curta de follow-up para ${name}.
Contexto:
- Origem: ${origin}
- Motivo do contato: ${reason}
- Última interação: ${lead?.lastInteraction || "há alguns dias"}
Objetivo: reengajar e facilitar o agendamento.
Regras:
- Use exatamente 1 emoji 💚 (obrigatório).
- Ofereça no máximo 2 janelas de horário, se fizer sentido.
- Termine com: "Posso te ajudar a agendar agora?".
`;

    try {
        let resp;
        try {
            resp = await openai.chat.completions.create({
                model: "gpt-5-mini",
                temperature: 0.7,
                max_tokens: 140,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: intro + user },
                ],
            });
        } catch {
            resp = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: 0.7,
                max_tokens: 140,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: intro + user },
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

// ======================================================
// 2) Resposta conversacional (para qualquer texto) — /reply e webhook
// ======================================================
// services/aiAmanda.js
export async function generateAmandaReply({ userText, lead = {}, context = {} }) {
    const name = (lead?.name || "").split(" ")[0] || "";
    const reason = lead?.reason || "avaliação/terapia";
    const origin = lead?.origin || "WhatsApp";

    // ===== 1) Sinal de intenção do usuário (quer agendar?) =====
    const textNorm = (userText || "").toLowerCase();
    const wantsSchedule = /\b(agendar|marcar|marcação|agenda|hor[aá]rio|consulta|agendamento)\b/.test(textNorm);

    // ===== 2) Heurística de "primeiro contato" =====
    const lastMsgs = Array.isArray(context?.lastMessages) ? context.lastMessages.slice(-5) : [];
    const greetings = /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|tudo\s*bem|bom\s*dia|fala|e[aíi])[\s!,.]*$/i;
    const isFirstContact =
        !!context?.isFirstContact ||
        lastMsgs.length === 0 ||
        greetings.test((userText || "").trim());

    // ===== 3) System prompt curto e firme =====
    const system = `
Você é a Amanda 💚, assistente da Clínica Fono Inova (Anápolis-GO).
Estilo: acolhedor, claro, proativo e curto (2–4 frases). SEM links. Use exatamente 1 💚.
Assine como "Equipe Fono Inova 💚".
Idioma: pt-BR.
Nunca invente preços/horários. Se precisar confirmar algo: "Vou verificar e já te retorno, por favor um momento 💚".
`.trim();

    // ===== 4) Prompt do usuário (primeiro contato vs. continuidade) =====
    const firstContactPrompt = `
Contexto: primeiro contato (saudação ou abertura de conversa).
Mensagem do cliente: """${(userText || "").trim()}"""
Sinal do sistema: wantsSchedule=${wantsSchedule ? "true" : "false"}.

Objetivo:
1) Cumprimentar pelo nome se souber (se não, cumprimente sem inventar).
2) Perguntar de forma aberta no que pode ajudar (ex.: "Em que posso te ajudar hoje?").
3) Se fizer sentido, oferecer 2 caminhos simples (ex.: avaliação ou tirar dúvidas rápidas).
4) Não ofereça horários ainda; espere a necessidade do cliente.
Regras:
- 2–4 frases curtas.
- Exatamente 1 emoji 💚.
- Termine convidando a pessoa a dizer a dúvida/necessidade.
`.trim();

    const ongoingPrompt = `
Contexto: conversa em andamento.
Mensagem do cliente: """${(userText || "").trim()}"""
Lead:
- Nome: ${name || "(desconhecido)"}
- Motivo: ${reason}
- Origem: ${origin}
Sinal do sistema: wantsSchedule=${wantsSchedule ? "true" : "false"}.

Objetivo:
- Responder a dúvida de forma objetiva.
- Se precisar de agenda/valor/endereço: diga "Vou verificar e já te retorno, por favor um momento 💚"
  e faça 1 pergunta objetiva (ex.: "prefere manhã ou tarde?").
- Não ofereça horários se o cliente NÃO pediu claramente para agendar.
- Somente se o cliente demonstrar intenção de agendar, ofereça no máximo 2 horários objetivos.
Regras:
- 2–4 frases curtas.
- Exatamente 1 emoji 💚.
- Final propositivo (ex.: "Posso te ajudar com mais alguma coisa?").
`.trim();

    const userPrompt = isFirstContact ? firstContactPrompt : ongoingPrompt;

    try {
        // ===== 5) Chamada ao modelo (com fallback) =====
        let resp;
        try {
            resp = await openai.chat.completions.create({
                model: "gpt-5-mini",
                temperature: isFirstContact ? 0.7 : 0.5,
                max_tokens: 160,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: userPrompt },
                ],
            });
        } catch {
            resp = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: isFirstContact ? 0.7 : 0.5,
                max_tokens: 160,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: userPrompt },
                ],
            });
        }

        // ===== 6) Texto gerado e fallback local =====
        let text = resp?.choices?.[0]?.message?.content?.trim() || "";
        if (!text) {
            text = isFirstContact
                ? `Oi${name ? `, ${name}` : ""}! Sou a Amanda da Fono Inova. Em que posso te ajudar hoje? 💚\n\nEquipe Fono Inova 💚`
                : `Vou verificar e já te retorno, por favor um momento 💚 Qual período fica melhor para você (manhã ou tarde)?\n\nEquipe Fono Inova 💚`;
        }

        // ===== 7) Pós-processo: bloquear oferta de horário quando NÃO houve intenção =====
        if (!isFirstContact && !wantsSchedule) {
            // remove sugestões evidentes de horários/opções
            text = text
                .replace(/\b(amanh[aã]|hoje|segunda|ter[cç]a|quarta|quinta|sexta|s[áa]bado|domingo)\b[^.!\n]{0,60}\b(\d{1,2}h(\d{2})?)\b/gi, "")
                .replace(/\b(\d{1,2}\s*h(\s*\d{2})?)\b/gi, "")
                .replace(/\b(op[cç][aã]o|hor[áa]rio)s?:?[^.!\n]+/gi, "");
            text = text.replace(/\s{2,}/g, " ").trim();
        }

        // ===== 8) Garantias: 💚 no corpo + assinatura final =====
        if (!text.includes("💚")) text += " 💚";
        if (!/Equipe Fono Inova 💚$/m.test(text.trim())) {
            text += `\n\nEquipe Fono Inova 💚`;
        }

        return text;
    } catch {
        return isFirstContact
            ? `Oi${name ? `, ${name}` : ""}! Sou a Amanda da Fono Inova. Em que posso te ajudar hoje? 💚\n\nEquipe Fono Inova 💚`
            : `Vou verificar e já te retorno, por favor um momento 💚 Qual período fica melhor para você (manhã ou tarde)?\n\nEquipe Fono Inova 💚`;
    }
}


