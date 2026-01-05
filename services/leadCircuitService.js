// services/leadCircuitService.js - VERSÃO CORRIGIDA
import { followupQueue } from '../config/bullConfig.js';
import Followup from '../models/Followup.js';
import Lead from '../models/Leads.js';

export const manageLeadCircuit = async (leadId, stage = 'initial') => {
    const lead = await Lead.findById(leadId);
    if (!lead) throw new Error('Lead não encontrado');

    const now = Date.now();
    const stageWindowMs = 24 * 60 * 60 * 1000;
    const dup = await Followup.findOne({
        lead: leadId,
        stage,
        status: { $in: ['scheduled', 'processing'] },
        scheduledAt: { $gte: new Date(now - stageWindowMs) }
    }).lean();

    if (dup) {
        console.log(`[CIRCUIT] Follow-up ${stage} já existe para lead ${leadId}`);  // ✅ FIX 1
        return dup;
    }

    const firstName = (name) => {
        if (!name) return '';
        const first = name.trim().split(/\s+/)[0];
        const blacklist = ['contato', 'cliente', 'lead', 'paciente'];
        return blacklist.includes(first.toLowerCase()) ? '' : first;
    };

    const circuitConfig = {
        initial: {
            hot: { delay: 1 * 60 * 60 * 1000 },    // 1h para hot
            warm: { delay: 2 * 60 * 60 * 1000 },   // 2h para warm
            cold: { delay: 4 * 60 * 60 * 1000 },   // 4h para cold
        },
        follow_up: {
            hot: { delay: 12 * 60 * 60 * 1000 },   // 12h
            warm: { delay: 24 * 60 * 60 * 1000 },  // 24h
            cold: { delay: 48 * 60 * 60 * 1000 },  // 48h
        },
    };

    const segment = lead.segment || "warm";
    const config = circuitConfig[stage][segment];
    if (!config) {
        console.warn(`[CIRCUIT] Stage desconhecido: ${stage}`);  // ✅ FIX 4
        return null;
    }

    const scheduledAt = new Date(now + (config.delay || 0));
    const initialStatus = scheduledAt.getTime() <= now ? 'processing' : 'scheduled';

    const f = await Followup.create({
        lead: leadId,
        stage,
        message: config.message,
        scheduledAt,
        status: initialStatus,
        origin: lead.origin,
        playbook: 'default',
        leadName: lead.name,
        leadPhoneE164: lead.contact?.phone || null,
    });

    const delayMs = scheduledAt.getTime() - Date.now();

    await followupQueue.add(
        'followup',
        { followupId: String(f._id) },
        {
            jobId: `fu-${f._id}`,
            ...(delayMs > 0 ? { delay: delayMs } : {})
        }
    );

    console.log(`[CIRCUIT] Follow-up ${stage} agendado para ${scheduledAt.toLocaleString('pt-BR')}`);  // ✅ FIX 5

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

export default manageLeadCircuit;