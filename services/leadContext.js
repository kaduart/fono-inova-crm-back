import Appointment from '../models/Appointment.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import { generateConversationSummary, needsNewSummary } from './conversationSummary.js';

export async function enrichLeadContext(leadId) {
    try {
        const lead = await Lead.findById(leadId)
            .populate('contact')
            .lean();

        if (!lead) {
            return getDefaultContext();
        }

        // ✅ Busca TODAS as mensagens (não limita mais)
        const messages = await Message.find({
            lead: leadId,
            type: 'text'
        })
            .sort({ timestamp: 1 }) // Ordem cronológica
            .lean();

        const totalMessages = messages.length;

        // ✅ Busca agendamentos
        const appointments = await Appointment.find({
            patient: lead.convertedToPatient
        }).lean();

        // 🧠 LÓGICA DE CONTEXTO INTELIGENTE
        let conversationHistory = [];
        let shouldGreet = true;
        let summaryContext = null;

        if (totalMessages === 0) {
            // Primeira mensagem ever
            conversationHistory = [];
            shouldGreet = true;
        }
        else if (totalMessages <= 20) {
            // Conversa curta: manda tudo
            conversationHistory = messages.map(msg => ({
                role: msg.direction === 'inbound' ? 'user' : 'assistant',
                content: msg.content,
                timestamp: msg.timestamp
            }));

            // Checa se deve cumprimentar (última msg >24h atrás)
            const lastMsgTime = messages[messages.length - 1].timestamp;
            const hoursSince = (Date.now() - new Date(lastMsgTime)) / (1000 * 60 * 60);
            shouldGreet = hoursSince > 24;
        }
        else {
            // Conversa longa (>20): resumo + últimas 20

            // 1. Verifica se precisa gerar novo resumo
            let leadDoc = await Lead.findById(leadId); // Busca versão mutável

            if (needsNewSummary(lead, totalMessages)) {
                console.log(`🧠 [CONTEXTO] Gerando resumo (${totalMessages} msgs)`);

                // Mensagens antigas (todas menos últimas 20)
                const oldMessages = messages.slice(0, -20);

                // Gera resumo
                const summary = await generateConversationSummary(oldMessages);

                if (summary) {
                    // Salva resumo no lead
                    await leadDoc.updateOne({
                        conversationSummary: summary,
                        summaryGeneratedAt: new Date(),
                        summaryCoversUntilMessage: totalMessages - 20
                    });

                    summaryContext = summary;
                    console.log(`💾 [CONTEXTO] Resumo salvo (cobre ${oldMessages.length} msgs antigas)`);
                }
            } else {
                // Reusa resumo existente
                summaryContext = lead.conversationSummary;
                console.log(`♻️ [CONTEXTO] Reutilizando resumo existente`);
            }

            // 2. Últimas 20 mensagens completas
            const recentMessages = messages.slice(-20);
            conversationHistory = recentMessages.map(msg => ({
                role: msg.direction === 'inbound' ? 'user' : 'assistant',
                content: msg.content,
                timestamp: msg.timestamp
            }));

            // 3. Checa saudação
            const lastMsgTime = recentMessages[recentMessages.length - 1].timestamp;
            const hoursSince = (Date.now() - new Date(lastMsgTime)) / (1000 * 60 * 60);
            shouldGreet = hoursSince > 24;
        }

        // ✅ Monta contexto final
        const context = {
            // Dados básicos
            leadId: lead._id,
            name: lead.name,
            phone: lead.contact?.phone,
            origin: lead.origin,

            // Status
            hasAppointments: appointments?.length > 0,
            isPatient: !!lead.convertedToPatient,
            conversionScore: lead.conversionScore || 0,
            status: lead.status,

            // Comportamento
            messageCount: totalMessages,
            lastInteraction: lead.lastInteractionAt,
            daysSinceLastContact: calculateDaysSince(lead.lastInteractionAt),

            // 🆕 CONTEXTO INTELIGENTE
            conversationHistory,      // Array [{role, content, timestamp}]
            conversationSummary: summaryContext, // String com resumo ou null
            shouldGreet,              // Boolean

            // Intenções (mantém pra flags)
            mentionedTherapies: extractMentionedTherapies(messages),

            // Estágio
            stage: determineLeadStage(lead, messages, appointments),

            // Flags úteis
            isFirstContact: totalMessages <= 1,
            isReturning: totalMessages > 3,
            needsUrgency: calculateDaysSince(lead.lastInteractionAt) > 7
        };

        console.log(`📊 [CONTEXTO] Lead: ${context.name} | Stage: ${context.stage} | Msgs: ${context.messageCount} | Resumo: ${summaryContext ? 'SIM' : 'NÃO'} | Saudação: ${shouldGreet ? 'SIM' : 'NÃO'}`);

        return context;

    } catch (error) {
        console.error('❌ [CONTEXTO] Erro:', error);
        return getDefaultContext();
    }
}

// Funções auxiliares permanecem iguais
function determineLeadStage(lead, messages, appointments) {
    if (lead.convertedToPatient || appointments?.length > 0) return 'paciente';
    if (lead.status === 'agendado') return 'agendado';
    if (messages.some(m => /agend|marcar|quero.*consulta/i.test(m.content))) return 'interessado_agendamento';
    if (messages.some(m => /pre[cç]o|valor|quanto.*custa/i.test(m.content))) return 'pesquisando_preco';
    if (messages.length >= 3) return 'engajado';
    if (messages.length > 0) return 'primeiro_contato';
    return 'novo';
}

function extractMentionedTherapies(messages) {
    const therapies = new Set();
    messages.forEach(msg => {
        const content = msg.content?.toLowerCase() || '';
        if (/neuropsic/i.test(content)) therapies.add('neuropsicológica');
        if (/fono/i.test(content)) therapies.add('fonoaudiologia');
        if (/psic[oó]log(?!.*neuro)/i.test(content)) therapies.add('psicologia');
        if (/terapia.*ocupacional|to\b/i.test(content)) therapies.add('terapia ocupacional');
        if (/fisio/i.test(content)) therapies.add('fisioterapia');
        if (/musico/i.test(content)) therapies.add('musicoterapia');
        if (/psicopedagog/i.test(content)) therapies.add('psicopedagogia');
    });
    return Array.from(therapies);
}

function calculateDaysSince(date) {
    if (!date) return 999;
    return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
}

function getDefaultContext() {
    return {
        stage: 'novo',
        isFirstContact: true,
        messageCount: 0,
        mentionedTherapies: [],
        conversationHistory: [],
        conversationSummary: null,
        shouldGreet: true,
        needsUrgency: false
    };
}

export default enrichLeadContext;