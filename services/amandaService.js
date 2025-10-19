// services/amandaService.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const baseStyle = `
Você é a Amanda 💚, assistente da Clínica Fono Inova (Anápolis-GO).
Estilo: acolhedor, claro, proativo e curto (2-4 frases). SEM links. Use sempre 1 💚.
Assine como "Equipe Fono Inova 💚".
Idioma: pt-BR.
`;

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
- Use 1 emoji 💚 (obrigatório).
- Se apropriado, ofereça 2 janelas de horário (ex.: amanhã 9h ou sexta 15h).
- Sempre encerre com: "Posso te ajudar a agendar agora?".
`;

    try {
        const resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.8,
            max_tokens: 140,
            messages: [
                { role: "system", content: system },
                { role: "user", content: intro + user }
            ],
        });

        const text = resp.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error("Resposta vazia da IA");

        // Garantia do 💚 (caso o modelo “esqueça”)
        return text.includes("💚") ? text : `${text} 💚`;
    } catch (err) {
        // Fallback seguro e brand-safe
        return `Oi ${name}, tudo bem? Passando para saber se posso te ajudar com ${reason}. Temos horários flexíveis nesta semana. Posso te ajudar a agendar agora? 💚`;
    }
}
