import dotenv from 'dotenv';
dotenv.config();

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * 🧠 GERA RESUMO INTELIGENTE DE CONVERSAS ANTIGAS
 * Extrai contexto essencial sem perder informação crítica
 */
export async function generateConversationSummary(messages) {
    if (!messages || messages.length === 0) {
        return null;
    }

    try {
        // Formatar mensagens pra análise
        const conversationText = messages
            .map((msg, idx) => {
                const speaker = msg.direction === 'inbound' ? 'CLIENTE' : 'AMANDA';
                return `[${idx + 1}] ${speaker}: ${msg.content}`;
            })
            .join('\n');

        const prompt = `
Analise as mensagens abaixo e extraia um RESUMO ESTRUTURADO e COMPLETO:

FORMATO OBRIGATÓRIO (use exatamente estes emojis e estrutura):
👤 LEAD: [nome se mencionou, telefone se relevante]
🎯 NECESSIDADE PRINCIPAL: [qual a dor/problema que motivou o contato - seja específico]
👶 PERFIL FAMILIAR: [quantos filhos, idades, nomes se mencionou, condições diagnósticas]
🏥 TERAPIAS DISCUTIDAS: [quais especialidades foram mencionadas ou pedidas]
💰 VALORES E PACOTES: [o que foi informado sobre preços, pacotes, formas de pagamento]
📍 CONTEXTO ADICIONAL: [cidade, bairro, escola, plano de saúde, qualquer detalhe útil]
⚠️ OBJEÇÕES/DÚVIDAS: [preocupações com preço, distância, horário, efetividade]
✅ ACORDOS E PRÓXIMOS PASSOS: [o que foi combinado - agendar, pensar, consultar alguém]
💬 TOM EMOCIONAL: [urgência, tranquilidade, ansiedade, interesse forte/fraco]

REGRAS CRÍTICAS:
- Seja ESPECÍFICO e FACTUAL (não invente, só extraia)
- Se algo NÃO foi mencionado, escreva "Não mencionado"
- Mantenha nomes, idades e valores EXATOS
- Capture NUANCES (ex: "achou caro mas entendeu o valor")
- Máximo 150 palavras no total

MENSAGENS PARA ANALISAR:
${conversationText}

RESPONDA APENAS COM O RESUMO ESTRUTURADO (sem introdução ou conclusão).
`.trim();

        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 500,
            temperature: 0.3, // Baixa pra ser mais factual
            system: "Você é um analista especializado em extrair contexto de conversas de atendimento. Seja preciso, factual e estruturado.",
            messages: [{
                role: "user",
                content: prompt
            }]
        });

        const summary = response.content[0]?.text?.trim();

        console.log(`✅ [RESUMO] Gerado com sucesso (${messages.length} msgs antigas)`);

        return summary;

    } catch (error) {
        console.error('❌ [RESUMO] Erro ao gerar:', error.message);
        return null;
    }
}

/**
 * 🔍 VERIFICA SE PRECISA GERAR NOVO RESUMO
 */
export function needsNewSummary(lead, totalMessages, futureAppointments = []) {
    // Caso 1: Nunca gerou resumo e tem >20 msgs
    if (!lead.conversationSummary && totalMessages > 20) {
        return true;
    }

    // Caso 2: Resumo existe mas tá velho (>24h)
    if (lead.summaryGeneratedAt) {
        const hoursSince = (Date.now() - new Date(lead.summaryGeneratedAt)) / (1000 * 60 * 60);
        if (hoursSince > 24) {
            return true;
        }
    }

    // Caso 3: Teve 20+ msgs novas desde último resumo
    if (lead.summaryCoversUntilMessage &&
        totalMessages > (lead.summaryCoversUntilMessage + 20)) {
        return true;
    }

    // ✅ Caso 4: Resumo menciona agendamento mas não tem mais nenhum futuro
    if (lead.conversationSummary && futureAppointments.length === 0) {
        const mentionsAppointment = /agendamento|avalia[çc][aã]o.*(confirmad|marcad)|confirmad[oa].*para|marcad[oa].*dia/i
            .test(lead.conversationSummary);

        // ✅ ADD LOG 3
        console.log("🔍 [NEEDS-SUMMARY] Caso 4 check:", {
            futureAppointments: futureAppointments.length,
            mentionsAppointment,
            summarySnippet: lead.conversationSummary?.substring(0, 150)
        });

        if (mentionsAppointment) {
            console.log("🔄 [RESUMO] Invalidando - menciona agendamento mas não há futuros");
            return true;
        }
    }

    return false;
}

export default generateConversationSummary;