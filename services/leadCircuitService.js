// services/leadCircuitService.js
import Followup from '../models/Followup.js';
import Lead from '../models/Leads.js';
import { enqueueFollowup } from "./followupQueueService.js";

export const manageLeadCircuit = async (leadId, stage = 'initial') => {
    const lead = await Lead.findById(leadId);
    if (!lead) throw new Error('Lead não encontrado');

    // Idempotência: evita duplicar follow-ups do mesmo stage nas últimas 24h
    const now = Date.now();
    const stageWindowMs = 24 * 60 * 60 * 1000;
    const dup = await Followup.findOne({
        lead: leadId,
        stage,
        status: { $in: ['scheduled', 'processing'] },
        scheduledAt: { $gte: new Date(now - stageWindowMs) }
    }).lean();
    if (dup) return dup;


    const circuitConfig = {
        initial: {
            delay: 2 * 60 * 60 * 1000,
            message: `Olá ${firstName(lead.name)}! 👋 Vimos seu interesse na Fono Inova. Posso ajudar com ${lead.appointment?.seekingFor || 'nossos serviços'}?`
        },
        follow_up: {
            delay: 24 * 60 * 60 * 1000,
            message: `Oi ${firstName(lead.name)}! 😊 Passando para saber se conseguiu ver nossas opções de ${lead.appointment?.healthPlan || 'planos'}. Tem alguma dúvida?`
        }
    };

    const config = circuitConfig[stage];
    if (!config) return null;
    const scheduledAt = new Date(now + (config.delay || 0));
    const initialStatus = scheduledAt.getTime() <= now ? 'processing' : 'scheduled';

    const f = await Followup.create({
        lead: leadId,
        stage, // 'initial' | 'follow_up'
        message: config.message,
        scheduledAt,
        status: initialStatus,
        origin: lead.origin,
        playbook: 'default',
        leadName: lead.name,
        leadPhoneE164: lead.contact?.phone || null,
    });


    // Enfileira apenas se ficou scheduled (futuro). Se já está "processing", sua
    // rotina de dispatcher imediato deve pegar e enviar (ou enfileire aqui também).
    await enqueueFollowup(f);

    // interação no lead (update atômico, evita race)
    await Lead.findByIdAndUpdate(
        leadId,
        {
            $push: {
                interactions: {
                    date: new Date(),
                    channel: "whatsapp",
                    direction: "outbound",
                    message: `Follow-up automático agendado: ${config.message.substring(0, 80)}...`,
                    status: "sent",
                }
            },
            $set: { lastInteractionAt: new Date() }
        },
        { new: false }
    );

    return f;
};
