/**
 * 🔄 INACTIVE LEAD FOLLOW-UP SERVICE
 * Verifica leads inativos (48h/72h) e cria follow-ups com urgência desenvolvimental sutil
 * 
 * REGRAS:
 * - ≤6 anos: Urgência desenvolvimental sutil ("cada semana que passa", "janela de desenvolvimento")
 * - >6 anos: Tom afetivo apenas, SEM urgência temporal
 * - Nunca "agende agora" ou "vai piorar" - sempre consultivo
 */

import Lead from "../models/Leads.js";
import Followup from "../models/Followup.js";
import Message from "../models/Message.js";
import { followupQueue } from "../config/bullConfig.js";
import { 
    generateFollowUpMessage, 
    checkFollowUpNeeded 
} from "./conversationSummary.js";
import { calculateOptimalFollowupTime } from "./intelligence/smartFollowup.js";

const MAX_FOLLOWUP_ATTEMPTS = 3;

/**
 * 🔍 Busca leads inativos que precisam de follow-up
 * Critérios:
 * - Última mensagem do lead há 48h+
 * - Status não é "agendado", "converted", "sem_interesse"
 * - Não tem agendamento futuro
 * - Não recebeu follow-up recente (48h)
 */
export async function findInactiveLeadsForFollowup() {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);

    const leads = await Lead.find({
        // Lead ativo (não convertido e não descartado)
        status: {
            $nin: ["agendado", "converted", "sem_interesse", "nao_interessado", "descartado"]
        },
        // Tem último contato registrado
        lastContactAt: { $exists: true, $lte: fortyEightHoursAgo },
        // Automação não foi desligada
        stopAutomation: { $ne: true },
        // BUG FIX: múltiplos $or em JS usam a ÚLTIMA declaração (as anteriores são ignoradas)
        // Usar $and para combinar todas as condições OR corretamente
        $and: [
            // Lead não convertido (convertedToPatient é null ou não existe)
            {
                $or: [
                    { convertedToPatient: { $exists: false } },
                    { convertedToPatient: null }
                ]
            },
            // Não tem agendamento futuro
            {
                $or: [
                    { nextAppointment: { $exists: false } },
                    { nextAppointment: null },
                    { nextAppointment: { $lte: new Date() } }
                ]
            },
            // Não recebeu follow-up nas últimas 48h
            {
                $or: [
                    { lastFollowUpAt: { $exists: false } },
                    { lastFollowUpAt: null },
                    { lastFollowUpAt: { $lte: fortyEightHoursAgo } }
                ]
            }
        ]
    })
    .select("name childData knownFacts qualificationData therapyArea lastContactAt lastFollowUpAt conversionScore")
    .limit(100)
    .lean();

    // Filtra leads que realmente precisam de follow-up
    const leadsNeedingFollowup = [];
    
    for (const lead of leads) {
        const result = checkFollowUpNeeded(lead);
        if (result.needsFollowUp) {
            // Verifica se já não tem follow-up agendado
            const existingFollowup = await Followup.findOne({
                lead: lead._id,
                status: { $in: ["scheduled", "processing"] },
                scheduledAt: { $gte: new Date() }
            }).lean();
            
            if (!existingFollowup) {
                leadsNeedingFollowup.push({
                    lead,
                    ...result
                });
            }
        }
    }

    return leadsNeedingFollowup;
}

/**
 * 📨 Cria follow-up para lead inativo
 */
export async function createInactiveLeadFollowup(lead, hoursSince, customMessage = null) {
    // Conta follow-ups já enviados para este lead
    const followupCount = await Followup.countDocuments({
        lead: lead._id,
        status: "sent"
    });
    
    // Limite de follow-ups
    if (followupCount >= MAX_FOLLOWUP_ATTEMPTS) {
        console.log(`[INACTIVE-FOLLOWUP] Lead ${lead._id} já atingiu limite de ${MAX_FOLLOWUP_ATTEMPTS} follow-ups`);
        return null;
    }

    // Gera mensagem personalizada
    const message = customMessage || generateFollowUpMessage(lead, hoursSince);
    
    // Calcula horário ótimo de envio
    const scheduledAt = calculateOptimalFollowupTime({
        lead,
        score: lead.conversionScore || 50,
        lastInteraction: lead.lastContactAt,
        attempt: followupCount + 1
    });

    // Cria follow-up
    const followup = await Followup.create({
        lead: lead._id,
        message,
        scheduledAt,
        status: "scheduled",
        aiOptimized: true,
        origin: lead.origin || "inactive_lead",
        note: `Follow-up automático ${hoursSince >= 72 ? '72h' : '48h'} - Amanda 2.0`,
        metadata: {
            hoursSinceLastContact: hoursSince,
            attempt: followupCount + 1,
            childAge: lead?.childData?.age || lead?.qualificationData?.childAge,
            hasDevelopmentalUrgency: (lead?.childData?.age || lead?.qualificationData?.childAge) <= 6
        }
    });

    // Agenda na fila
    const delayMs = scheduledAt.getTime() - Date.now();
    await followupQueue.add(
        "followup",
        { followupId: followup._id },
        {
            jobId: `fu-inactive-${followup._id}`,
            ...(delayMs > 0 ? { delay: delayMs } : {})
        }
    );

    // Atualiza lead
    await Lead.findByIdAndUpdate(lead._id, {
        lastFollowUpAt: new Date(),
        $push: {
            interactions: {
                date: new Date(),
                channel: "whatsapp",
                direction: "outbound",
                message: `Follow-up ${hoursSince >= 72 ? '72h' : '48h'} agendado: ${message.substring(0, 80)}...`,
                status: "scheduled"
            }
        }
    });

    console.log(`[INACTIVE-FOLLOWUP] Criado follow-up ${hoursSince >= 72 ? '72h' : '48h'} para lead ${lead._id}`);
    
    return followup;
}

/**
 * 🚀 Processa todos os leads inativos e cria follow-ups
 */
export async function processInactiveLeads() {
    console.log("[INACTIVE-FOLLOWUP] Iniciando verificação de leads inativos...");
    
    try {
        const inactiveLeads = await findInactiveLeadsForFollowup();
        
        if (inactiveLeads.length === 0) {
            console.log("[INACTIVE-FOLLOWUP] Nenhum lead inativo encontrado");
            return { processed: 0, created: 0 };
        }

        console.log(`[INACTIVE-FOLLOWUP] ${inactiveLeads.length} leads inativos encontrados`);

        let created = 0;
        
        for (const { lead, hoursSince, message } of inactiveLeads) {
            try {
                const followup = await createInactiveLeadFollowup(lead, hoursSince, message);
                if (followup) created++;
            } catch (error) {
                console.error(`[INACTIVE-FOLLOWUP] Erro ao criar follow-up para lead ${lead._id}:`, error.message);
            }
        }

        console.log(`[INACTIVE-FOLLOWUP] Concluído: ${created} follow-ups criados`);
        return { processed: inactiveLeads.length, created };
        
    } catch (error) {
        console.error("[INACTIVE-FOLLOWUP] Erro no processamento:", error);
        throw error;
    }
}

export default {
    findInactiveLeadsForFollowup,
    createInactiveLeadFollowup,
    processInactiveLeads
};
