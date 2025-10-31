// services/leadCircuitService.js - COMPATÍVEL
import Followup from '../models/Followup.js';
import Lead from '../models/Leads.js';

export const manageLeadCircuit = async (leadId, stage = 'initial') => {
    try {
        const lead = await Lead.findById(leadId);
        if (!lead) throw new Error('Lead não encontrado');

        const circuitConfig = {
            initial: {
                delay: 2 * 60 * 60 * 1000, // 2 horas
                message: `Olá ${lead.name.split(' ')[0]}! 👋 Vimos seu interesse na Fono Inova. Posso ajudar com ${lead.appointment?.seekingFor || 'nossos serviços'}?`
            },
            follow_up: {
                delay: 24 * 60 * 60 * 1000, // 24 horas
                message: `Oi ${lead.name.split(' ')[0]}! 😊 Passando para saber se conseguiu ver nossas opções de ${lead.appointment?.healthPlan || 'planos'}. Tem alguma dúvida?`
            }
        };

        const config = circuitConfig[stage];
        if (!config) return;

        // Criar follow-up no sistema existente
        const followup = await Followup.create({
            lead: leadId,
            message: config.message,
            scheduledAt: new Date(Date.now() + config.delay),
            status: 'scheduled'
        });

        // Registrar interação no lead
        lead.interactions.push({
            date: new Date(),
            channel: 'whatsapp',
            direction: 'outbound',
            message: `Follow-up automático agendado: ${config.message.substring(0, 50)}...`,
            status: 'sent'
        });

        await lead.save();

        return followup;
    } catch (error) {
        console.error('Erro no circuito de lead:', error);
        throw error;
    }
};