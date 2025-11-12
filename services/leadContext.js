// services/leadContext.js - SISTEMA DE CONTEXTO INTELIGENTE

import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import Appointment from '../models/Appointment.js';

/**
 * 🎯 ENRIQUECE CONTEXTO DO LEAD
 * Usa dados que JÁ EXISTEM no banco para personalizar respostas
 */
export async function enrichLeadContext(leadId) {
    try {
        // ✅ Busca lead com dados relacionados
        const lead = await Lead.findById(leadId)
            .populate('contact')
            .lean();
        
        if (!lead) {
            return getDefaultContext();
        }
        
        // ✅ Busca histórico de mensagens
        const messages = await Message.find({
            lead: leadId,
            type: 'text'
        })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean();
        
        // ✅ Busca agendamentos
        const appointments = await Appointment.find({
            patient: lead.convertedToPatient
        }).lean();
        
        // ✅ Analisa comportamento
        const context = {
            // Dados básicos
            leadId: lead._id,
            name: lead.name,
            phone: lead.contact?.phone,
            origin: lead.origin,
            
            // 🎯 Status do lead
            hasAppointments: appointments?.length > 0,
            isPatient: !!lead.convertedToPatient,
            conversionScore: lead.conversionScore || 0,
            status: lead.status,
            
            // 🎯 Comportamento
            messageCount: messages.length,
            lastInteraction: lead.lastInteractionAt,
            daysSinceLastContact: calculateDaysSince(lead.lastInteractionAt),
            
            // 🎯 Intenções detectadas
            mentionedTherapies: extractMentionedTherapies(messages),
            askedAboutPrice: messages.some(m => /pre[cç]o|valor|quanto/i.test(m.content)),
            askedAboutSchedule: messages.some(m => /agend|marcar|hor[aá]rio/i.test(m.content)),
            askedAboutAddress: messages.some(m => /endere[cç]o|onde fica/i.test(m.content)),
            
            // 🎯 Estágio do funil
            stage: determineLeadStage(lead, messages, appointments),
            
            // 🎯 Histórico recente (últimas 5 mensagens)
            lastMessages: messages.slice(0, 5).map(m => m.content),
            
            // 🎯 Flags úteis
            isFirstContact: messages.length <= 1,
            isReturning: messages.length > 3,
            needsUrgency: calculateDaysSince(lead.lastInteractionAt) > 7
        };
        
        console.log(`📊 [CONTEXTO] Lead: ${context.name} | Stage: ${context.stage} | Msgs: ${context.messageCount}`);
        
        return context;
        
    } catch (error) {
        console.error('❌ Erro ao enriquecer contexto:', error);
        return getDefaultContext();
    }
}

/**
 * 🎯 DETERMINA ESTÁGIO DO LEAD NO FUNIL
 */
function determineLeadStage(lead, messages, appointments) {
    // Paciente ativo
    if (lead.convertedToPatient || appointments?.length > 0) {
        return 'paciente';
    }
    
    // Agendado mas ainda não é paciente
    if (lead.status === 'agendado') {
        return 'agendado';
    }
    
    // Interessado em agendar
    if (messages.some(m => /agend|marcar|quero.*consulta/i.test(m.content))) {
        return 'interessado_agendamento';
    }
    
    // Pesquisando preço
    if (messages.some(m => /pre[cç]o|valor|quanto.*custa/i.test(m.content))) {
        return 'pesquisando_preco';
    }
    
    // Engajado (3+ mensagens)
    if (messages.length >= 3) {
        return 'engajado';
    }
    
    // Primeiro contato
    if (messages.length > 0) {
        return 'primeiro_contato';
    }
    
    // Novo (sem histórico)
    return 'novo';
}

/**
 * 🔍 EXTRAI TERAPIAS MENCIONADAS NO HISTÓRICO
 */
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

/**
 * 📅 CALCULA DIAS DESDE UMA DATA
 */
function calculateDaysSince(date) {
    if (!date) return 999;
    const now = Date.now();
    const then = new Date(date).getTime();
    return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

/**
 * 🔄 CONTEXTO PADRÃO (FALLBACK)
 */
function getDefaultContext() {
    return {
        stage: 'novo',
        isFirstContact: true,
        messageCount: 0,
        mentionedTherapies: [],
        lastMessages: [],
        needsUrgency: false
    };
}

export default enrichLeadContext;