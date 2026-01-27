// services/leadContext.js

import Appointment from '../models/Appointment.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import { generateConversationSummary, needsNewSummary } from './conversationSummary.js';

export async function enrichLeadContext(leadId) {
    try {
        // ✅ NÃO usa populate('contact') porque no seu schema contact é objeto embutido
        const lead = await Lead.findById(leadId).lean();

        if (!lead) {
            return getDefaultContext();
        }

        // ✅ Busca TODAS as mensagens (não limita)
        const messages = await Message.find({
            lead: leadId,
            type: { $in: ['text', 'template', 'image', 'audio', 'video', 'document'] }
        })
            .sort({ timestamp: 1 })
            .lean();

        const totalMessages = messages.length;

        // ✅ Busca agendamentos FUTUROS (só se já virou paciente)
        const today = new Date().toISOString().split('T')[0];
        const appointments = lead.convertedToPatient
            ? await Appointment.find({
                patient: lead.convertedToPatient,
                date: { $gte: today }
            }).lean()
            : [];

        // 🧠 CONTEXTO INTELIGENTE
        let conversationHistory = [];
        let shouldGreet = true;
        let summaryContext = lead.conversationSummary || null;

        if (totalMessages === 0) {
            conversationHistory = [];
            shouldGreet = true;
        }
        else if (totalMessages <= 20) {
            // Conversa curta: manda tudo
            conversationHistory = messages
                .filter(msg => (msg.content || '').toString().trim().length > 0)
                .map(msg => ({
                    role: msg.direction === 'inbound' ? 'user' : 'assistant',
                    content: msg.content,
                    timestamp: msg.timestamp,
                    type: msg.type
                }));

            // Checa saudação
            const lastMsgTime = messages[messages.length - 1]?.timestamp;
            if (lastMsgTime) {
                const hoursSince = (Date.now() - new Date(lastMsgTime)) / (1000 * 60 * 60);
                shouldGreet = hoursSince > 24;
            }
        }
        else {
            // Conversa longa: resumo + últimas 20
            let leadDoc = await Lead.findById(leadId); // versão mutável

            if (needsNewSummary(lead, totalMessages, appointments)) {
                const oldMessages = messages.slice(0, -20);
                const summary = await generateConversationSummary(oldMessages);

                if (summary) {
                    await leadDoc.updateOne({
                        conversationSummary: summary,
                        summaryGeneratedAt: new Date(),
                        summaryCoversUntilMessage: totalMessages - 20
                    });

                    summaryContext = summary;
                }
            } else {
                summaryContext = lead.conversationSummary;
            }

            const recentMessages = messages.slice(-20);
            conversationHistory = recentMessages
                .filter(msg => (msg.content || '').toString().trim().length > 0)
                .map(msg => ({
                    role: msg.direction === 'inbound' ? 'user' : 'assistant',
                    content: msg.content,
                    timestamp: msg.timestamp,
                    type: msg.type
                }));

            const lastMsgTime = recentMessages[recentMessages.length - 1]?.timestamp;
            if (lastMsgTime) {
                const hoursSince = (Date.now() - new Date(lastMsgTime)) / (1000 * 60 * 60);
                shouldGreet = hoursSince > 24;
            }
        }

        // ✅ Normalizações alinhadas ao schema (COM ALIASES E QUEIXA)
        const patientAge =
            lead.patientInfo?.age ??
            lead.patientAge ??
            lead.qualificationData?.extractedInfo?.age ??
            lead.qualificationData?.extractedInfo?.idade ??
            null;

        const ageGroup =
            lead.qualificationData?.extractedInfo?.idadeRange ??
            null;

        const preferredTime =
            lead.pendingPreferredPeriod ?? // ✅ campo real no schema
            lead.preferredTime ??
            lead.autoBookingContext?.preferredPeriod ??
            lead.qualificationData?.extractedInfo?.disponibilidade ??
            lead.qualificationData?.extractedInfo?.preferredPeriod ??
            null;

        const therapyArea =
            lead.therapyArea ??
            lead.autoBookingContext?.therapyArea ??
            lead.qualificationData?.extractedInfo?.therapyArea ??
            lead.qualificationData?.extractedInfo?.areaTerapia ??
            null;

        // 🆕 QUEIXA PRINCIPAL (Primary Complaint) - ESSENCIAL PARA O ACOLHIMENTO
        const primaryComplaint =
            lead.primaryComplaint ??
            lead.qualificationData?.extractedInfo?.queixa ??
            lead.qualificationData?.extractedInfo?.sintomas ??
            lead.qualificationData?.extractedInfo?.motivoConsulta ??
            lead.qualificationData?.extractedInfo?.complaint ??
            null;

        // ✅ Monta contexto final (COMPLETO)
        const context = {
            // Dados básicos
            leadId: lead._id,
            name: lead.name || null,
            // 🆕 ALIAS: leadName (usado por alguns handlers antigos)
            leadName: lead.name || lead.patientName || null,
            // 🆕 PRIMEIRO NOME (para saudações personalizadas)
            leadFirstName: lead.name ? lead.name.split(' ')[0] : null,

            phone: lead.contact?.phone || lead.phone || null,
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

            // Dados do paciente
            patientAge,
            ageGroup,
            preferredTime,

            // 🆕 QUEIXA (para o fluxo de acolhimento obrigatório)
            primaryComplaint,
            complaint: primaryComplaint, // alias

            // Slots / agendamento
            chosenSlot: lead.pendingChosenSlot || lead.autoBookingContext?.chosenSlot || null,
            pendingChosenSlot: lead.pendingChosenSlot || null,

            pendingSchedulingSlots: lead.pendingSchedulingSlots || null,
            // 🆕 ALIAS: pendingSlots (busca em várias fontes)
            pendingSlots: lead.pendingSchedulingSlots ?? lead.autoBookingContext?.pendingSchedulingSlots ?? lead.autoBookingContext?.lastOfferedSlots ?? null,

            autoBookingContext: lead.autoBookingContext || null,
            therapyArea,

            // Contexto inteligente
            conversationHistory,
            conversationSummary: summaryContext,
            shouldGreet, // 🆕 ESSENCIAL: controla se pode usar memória ou não

            // Intenções (flags)
            mentionedTherapies: extractMentionedTherapies(messages),

            // Estágio
            stage: determineLeadStage(lead, messages, appointments),

            // Flags úteis
            isFirstContact: totalMessages <= 1,
            isReturning: totalMessages > 3,
            needsUrgency: calculateDaysSince(lead.lastInteractionAt) > 7,

            futureAppointmentsCount: appointments?.length || 0,
            appointmentsInfo: appointments?.length > 0
                ? appointments.map(a => ({ date: a.date, time: a.time, type: a.type }))
                : null,

            appointmentWarning: appointments?.length === 0
                ? '⚠️ ATENÇÃO: Este lead NÃO possui agendamentos futuros. NÃO mencione consultas marcadas ou confirmadas.'
                : null,

            // 🆕 DEBUG: campos brutos para facilitar troubleshooting
            _debug: {
                rootTherapy: lead.therapyArea,
                autoBookingTherapy: lead.autoBookingContext?.therapyArea,
                qualificationTherapy: lead.qualificationData?.extractedInfo?.therapyArea,
                hasComplaint: !!primaryComplaint,
                hasSlots: !!(lead.pendingSchedulingSlots || lead.autoBookingContext?.pendingSchedulingSlots)
            }
        };

        return context;

    } catch (error) {
        console.error('Erro ao montar contexto do lead:', error);
        return getDefaultContext();
    }
}

function determineLeadStage(lead, messages, appointments) {
    if (!lead) return 'unknown';

    // se já virou paciente
    if (lead.convertedToPatient) return 'paciente';

    // se tem agendamento futuro
    if (appointments && appointments.length > 0) return 'interessado_agendamento';

    // heurística simples por status/stage
    if (lead.stage) return lead.stage;
    if (lead.status === 'engajado') return 'engajado';
    if (lead.status === 'agendado') return 'interessado_agendamento';

    // fallback por volume de mensagens
    if ((messages?.length || 0) > 3) return 'engajado';

    return 'novo';
}

function extractMentionedTherapies(messages) {
    const text = (messages || [])
        .map(m => m.content || '')
        .join(' ')
        .toLowerCase();

    const therapies = [];

    const map = [
        { key: 'fonoaudiologia', patterns: ['fono', 'fonoaudiolog'] },
        { key: 'psicologia', patterns: ['psico', 'psicolog'] },
        { key: 'terapia ocupacional', patterns: ['to', 'terapia ocup'] },
        { key: 'fisioterapia', patterns: ['fisio'] },
        { key: 'neuropsicologia', patterns: ['neuropsic'] },
    ];

    for (const item of map) {
        if (item.patterns.some(p => text.includes(p))) therapies.push(item.key);
    }

    return therapies;
}

function calculateDaysSince(date) {
    if (!date) return 999;
    const diff = Date.now() - new Date(date).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getDefaultContext() {
    return {
        leadId: null,
        leadName: null,
        leadFirstName: null,
        phone: null,
        origin: null,
        patientName: lead.patientInfo?.name || null,

        hasAppointments: false,
        isPatient: false,
        conversionScore: 0,
        status: 'novo',

        messageCount: 0,
        lastInteraction: null,
        daysSinceLastContact: 999,

        patientAge: null,
        ageGroup: null,
        preferredTime: null,

        // 🆕 Campos novos no default
        primaryComplaint: null,
        complaint: null,

        chosenSlot: null,
        pendingChosenSlot: null,
        pendingSchedulingSlots: null,
        pendingSlots: null,

        autoBookingContext: null,
        therapyArea: null,

        conversationHistory: [],
        conversationSummary: null,
        shouldGreet: true,

        mentionedTherapies: [],
        stage: 'novo',

        isFirstContact: true,
        isReturning: false,
        needsUrgency: false,

        futureAppointmentsCount: 0,
        appointmentsInfo: null,

        appointmentWarning: '⚠️ ATENÇÃO: Este lead NÃO possui agendamentos futuros. NÃO mencione consultas marcadas ou confirmadas.',

        _debug: null
    };
}

export default enrichLeadContext;