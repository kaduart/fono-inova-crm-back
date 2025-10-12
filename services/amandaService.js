import axios from "axios";

export const generateFollowupMessage = async (lead) => {
    const prompt = `
Você é Amanda, assistente da Clínica Fono Inova em Anápolis.
Gere uma mensagem curta e acolhedora de follow-up para ${lead.name}, que entrou por ${lead.origin}.
O objetivo é reengajar o contato de forma natural.
Contexto:
- Motivo: ${lead.reason || "não informado"}
- Última interação: ${lead.lastInteraction || "há alguns dias"}
`;

    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
    }, {
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
    });

    return res.data.choices[0].message.content.trim();
};
