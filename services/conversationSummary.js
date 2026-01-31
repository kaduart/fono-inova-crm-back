import dotenv from 'dotenv';
import callAI from './IA/Aiproviderservice.js';
dotenv.config();

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

        const summary = await callAI({
            systemPrompt: "Você é um analista especializado em extrair contexto de conversas de atendimento. Seja preciso, factual e estruturado. Responda SEMPRE em português brasileiro.",
            messages: [{ role: "user", content: prompt }],
            maxTokens: 500,
            temperature: 0.3,
            usePremiumModel: true // Usa Llama 70B pra resumos mais elaborados
        });

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
/**
 * 🔄 PLACEHOLDER - Resumo é gerado em enrichLeadContext
 */
export async function update(leadId, newMessageText) {
    // Resumo é regenerado automaticamente quando needsNewSummary() = true
    // Chamado por enrichLeadContext
    return null;
}

// ======================================================
// 🆕 FOLLOW-UP AUTOMÁTICO - Mensagens 48h/72h
// Tom consultivo, urgência desenvolvimental sutil para ≤6 anos
// ======================================================

/**
 * Gera mensagem de follow-up baseada no tempo desde último contato
 * REGRA OURO: Nunca "agende agora" | Sempre consultivo | Urgência como cuidado
 */
export function generateFollowUpMessage(lead, hoursSinceLastContact = 48) {
    const childName = extractChildName(lead);
    const childAge = extractChildAgeForFollowUp(lead);
    const parentName = lead?.name?.split(' ')[0] || "";
    const therapyType = lead?.therapyArea || lead?.knownFacts?.therapyType || "avaliação";
    const hasDevelopmentalUrgency = childAge !== null && childAge <= 6;
    
    // Seleciona template baseado no tempo
    if (hoursSinceLastContact >= 72) {
        return generate72hFollowUp({ parentName, childName, childAge, hasDevelopmentalUrgency, therapyType });
    } else {
        return generate48hFollowUp({ parentName, childName, childAge, hasDevelopmentalUrgency, therapyType });
    }
}

/**
 * Extrai nome da criança de várias fontes
 */
function extractChildName(lead) {
    return lead?.childData?.name || 
           lead?.knownFacts?.childName || 
           lead?.qualificationData?.childName ||
           null;
}

/**
 * Extrai idade da criança para follow-up
 */
function extractChildAgeForFollowUp(lead) {
    if (lead?.knownFacts?.childAge) return parseInt(lead.knownFacts.childAge);
    if (lead?.qualificationData?.childAge) return parseInt(lead.qualificationData.childAge);
    if (lead?.childData?.age) return parseInt(lead.childData.age);
    
    // Tenta extrair do resumo
    const summary = lead?.conversationSummary || "";
    const ageMatch = summary.match(/(\d+)\s*(?:anos?|anos de idade)/i);
    if (ageMatch) return parseInt(ageMatch[1]);
    
    return null;
}

/**
 * Follow-up 48h - Tom consultivo, urgência explicada como ciência
 */
function generate48hFollowUp({ parentName, childName, childAge, hasDevelopmentalUrgency, therapyType }) {
    if (hasDevelopmentalUrgency && childAge !== null) {
        // Urgência desenvolvimental SUTIL - consultiva, não ameaçadora
        return `${parentName ? parentName + ", " : ""}fiquei pensando no que conversamos sobre o${childName ? " " + childName : " seu filho"} 💚

Sei que está corrido, mas nessa idade (${childAge} anos), cada semana que passa é uma oportunidade de desenvolvimento que não volta da mesma forma. Não quero pressionar — só quero que saiba que quanto antes iniciarmos, mais leve será o caminho dele.

Estou aqui quando sentir que é o momento 🤗`;
    }
    
    // >6 anos - Tom afetivo, SEM urgência temporal
    return `${parentName ? parentName + ", " : ""}como você está? 💚

Sei que passaram alguns dias e a vida não para. Só queria saber se está tudo bem com vocês${childName ? " — e como vai o " + childName : ""}.

Quando quiser retomar nossa conversa sobre a ${therapyType}, estarei aqui. No seu tempo 🤗`;
}

/**
 * Follow-up 72h - Último toque, mais direto mas sempre consultivo
 */
function generate72hFollowUp({ parentName, childName, childAge, hasDevelopmentalUrgency, therapyType }) {
    if (hasDevelopmentalUrgency && childAge !== null) {
        // Urgência consultiva máxima, mas ainda sem pressão
        return `${parentName ? parentName + ", " : ""}preciso ser honesta com você 💚

Com ${childAge} anos, o ${childName || "seu filho"} está em uma fase onde cada mês faz diferença real no desenvolvimento. Não estou dizendo isso para pressionar — estou dizendo porque me importo.

Se for para fazer, quanto antes, melhor para ele. Se não for agora, também tudo bem. Mas não quero que passe mais tempo sem pelo menos saber das opções.

Posso te ajudar com isso? 🤗`;
    }
    
    // >6 anos - Tom afetivo, convite final sem urgência
    return `${parentName ? parentName + ", " : ""}passando para um último toque 💚

Sei que a vida é corrida e às vezes a gente acaba deixando as coisas para depois. Mas queria que soubesse que estou aqui se precisar${childName ? " do " + childName : ""}.

Nossa ${therapyType} pode fazer diferença — quando você estiver pront${parentName ? "a" : "o"}, estarei aqui 🤗`;
}

/**
 * Verifica se lead precisa de follow-up automático
 * Retorna { needsFollowUp: boolean, message?: string }
 */
export function checkFollowUpNeeded(lead) {
    if (!lead?.lastContactAt) return { needsFollowUp: false };
    
    const hoursSince = (Date.now() - new Date(lead.lastContactAt)) / (1000 * 60 * 60);
    
    // Só faz follow-up se:
    // 1. Passou 48h desde último contato
    // 2. Lead não está agendado
    // 3. Lead não foi descartado
    // 4. Não enviou follow-up nas últimas 48h
    
    const hasAppointment = lead?.nextAppointment && new Date(lead.nextAppointment) > new Date();
    const isDiscarded = lead?.stage === 'descartado' || lead?.stage === 'nao_interessado';
    const recentFollowUp = lead?.lastFollowUpAt && 
        ((Date.now() - new Date(lead.lastFollowUpAt)) / (1000 * 60 * 60)) < 48;
    
    if (hoursSince >= 48 && !hasAppointment && !isDiscarded && !recentFollowUp) {
        return {
            needsFollowUp: true,
            message: generateFollowUpMessage(lead, hoursSince),
            hoursSince
        };
    }
    
    return { needsFollowUp: false };
}

export default generateConversationSummary;