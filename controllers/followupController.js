// controllers/followupController.js - VERSÃO AMANDA 2.0
import { followupQueue } from "../config/bullConfig.js";
import Followup from '../models/Followup.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';

// ✅ AMANDA 2.0
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import {
    calculateOptimalFollowupTime,
    generateContextualFollowup
} from "../services/intelligence/smartFollowup.js";

// ⚠️ FALLBACK (Amanda 1.0)
import { generateFollowupMessage } from "../services/aiAmandaService.js";

/**
 * 🧩 Agendar novo follow-up (com Amanda 2.0)
 * POST /api/followups/schedule
 */
export const scheduleFollowup = async (req, res) => {
    try {
        const { leadId, message, scheduledAt, aiOptimized = false } = req.body;

        if (!leadId || !scheduledAt)
            return res.status(400).json({ error: 'Campos obrigatórios: leadId, scheduledAt' });

        const lead = await Lead.findById(leadId);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
        if (!lead.contact?.phone)
            return res.status(400).json({ error: 'Lead sem telefone cadastrado' });

        const delay = new Date(scheduledAt).getTime() - Date.now();
        if (delay < 0)
            return res.status(400).json({ error: 'Data/hora precisa ser futura' });

        let finalMessage = message;
        let amandaVersion = '1.0';

        // 🤖 AMANDA 2.0 - GERAÇÃO INTELIGENTE
        if (aiOptimized || !message?.trim()) {
            try {
                // Buscar histórico
                const recentMessages = await Message.find({
                    lead: leadId
                }).sort({ timestamp: -1 }).limit(10).lean();

                const lastInbound = recentMessages.find(m => m.direction === 'inbound');

                if (lastInbound?.content) {
                    // Usar Amanda 2.0
                    const analysis = await analyzeLeadMessage({
                        text: lastInbound.content,
                        lead,
                        history: recentMessages.map(m => m.content || '')
                    });

                    finalMessage = generateContextualFollowup({
                        lead,
                        analysis,
                        attempt: 1
                    });

                    amandaVersion = '2.0';
                    console.log(`🤖 Amanda 2.0 gerou mensagem para lead ${lead.name}`);
                } else {
                    // Fallback Amanda 1.0
                    finalMessage = await generateFollowupMessage(lead);
                    console.log(`🤖 Amanda 1.0 gerou mensagem para lead ${lead.name}`);
                }
            } catch (aiError) {
                console.warn("⚠️ Erro na Amanda AI, usando fallback:", aiError.message);
                if (!message?.trim()) {
                    finalMessage = `Olá ${lead.name?.split(' ')[0] || ''}! Passando para saber se posso te ajudar com ${lead.reason || 'nossos serviços'}. Posso te ajudar? 💚`;
                }
            }
        }

        const followup = await Followup.create({
            lead: leadId,
            message: finalMessage,
            scheduledAt,
            status: 'scheduled',
            aiOptimized: aiOptimized || !message?.trim(),
            origin: lead.origin,
            note: `Amanda ${amandaVersion} - Agendado manualmente`
        });

        // ✅ ADICIONAR NA FILA
        await followupQueue.add('followup', { followupId: followup._id }, {
            delay,
            jobId: `fu-${followup._id}`
        });

        res.status(201).json({
            success: true,
            message: 'Follow-up agendado com sucesso!',
            data: followup,
            meta: { amandaVersion }
        });
    } catch (err) {
        console.error("❌ Erro ao agendar follow-up:", err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * 🆕 Criar follow-up (usado pelo FollowupComposer)
 * POST /api/followups
 */
export const createFollowup = async (req, res) => {
    try {
        const lead = await Lead.findById(req.body.lead);
        if (!lead) {
            return res.status(404).json({
                success: false,
                message: "Lead não encontrado"
            });
        }

        let message = req.body.message;
        let amandaVersion = '1.0';

        // ✨ Se mensagem vazia, Amanda 2.0 cria automaticamente
        if (!message || message.trim() === "") {
            try {
                // Tentar Amanda 2.0
                const recentMessages = await Message.find({
                    lead: lead._id
                }).sort({ timestamp: -1 }).limit(10).lean();

                const lastInbound = recentMessages.find(m => m.direction === 'inbound');

                if (lastInbound?.content) {
                    const analysis = await analyzeLeadMessage({
                        text: lastInbound.content,
                        lead,
                        history: recentMessages.map(m => m.content || '')
                    });

                    message = generateContextualFollowup({
                        lead,
                        analysis,
                        attempt: 1
                    });
                    amandaVersion = '2.0';
                } else {
                    // Fallback Amanda 1.0
                    message = await generateFollowupMessage(lead);
                }
            } catch (aiError) {
                console.warn('⚠️ Amanda falhou, usando fallback:', aiError.message);
                message = await generateFollowupMessage(lead);
            }
        }

        const scheduledAt = req.body.scheduledAt || new Date();

        const followup = await Followup.create({
            lead: lead._id,
            message,
            scheduledAt,
            status: "scheduled",
            playbook: req.body.playbook || null,
            note: req.body.note || `Amanda ${amandaVersion}`,
            origin: lead.origin,
            aiOptimized: !req.body.message || req.body.message.trim() === ""
        });

        // ✅ ADICIONAR NA FILA (CRÍTICO!)
        const delay = new Date(scheduledAt).getTime() - Date.now();
        if (delay > 0) {
            await followupQueue.add('followup', { followupId: followup._id }, {
                delay,
                jobId: `fu-${followup._id}`
            });
        } else {
            // Se já passou a hora, envia imediatamente
            await followupQueue.add('followup', { followupId: followup._id }, {
                jobId: `fu-${followup._id}`
            });
        }

        res.json({
            success: true,
            data: followup,
            meta: { amandaVersion }
        });
    } catch (err) {
        console.error("❌ Erro ao criar follow-up:", err);
        res.status(500).json({ success: false, error: err.message });
    }
};

/**
 * 🧠 Criar follow-up inteligente com Amanda 2.0
 * POST /api/followups/ai
 */
export const createAIFollowup = async (req, res) => {
    try {
        const { leadId, scheduledAt, objective } = req.body;

        if (!leadId) return res.status(400).json({ error: 'leadId é obrigatório' });

        const lead = await Lead.findById(leadId);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        // 🎯 AMANDA 2.0 - ANÁLISE COMPLETA
        const recentMessages = await Message.find({
            lead: leadId
        }).sort({ timestamp: -1 }).limit(10).lean();

        const lastInbound = recentMessages.find(m => m.direction === 'inbound');

        let message;
        let score = lead.conversionScore || 50;

        if (lastInbound?.content) {
            const analysis = await analyzeLeadMessage({
                text: lastInbound.content,
                lead,
                history: recentMessages.map(m => m.content || '')
            });

            message = generateContextualFollowup({
                lead,
                analysis,
                attempt: 1
            });

            score = analysis.score;

            // Atualizar score do lead
            await Lead.findByIdAndUpdate(leadId, {
                conversionScore: score,
                lastScoreUpdate: new Date()
            });
        } else {
            // Fallback
            message = await generateFollowupMessage(lead);
        }

        // Calcular melhor horário
        const optimalTime = scheduledAt ?
            new Date(scheduledAt) :
            calculateOptimalFollowupTime({
                lead,
                score,
                lastInteraction: new Date(),
                attempt: 1
            });

        const followup = await Followup.create({
            lead: leadId,
            message,
            scheduledAt: optimalTime,
            status: 'scheduled',
            aiOptimized: true,
            origin: lead.origin,
            note: `Amanda 2.0 - ${objective || 'reengajamento'} | Score: ${score}`
        });

        const delay = new Date(followup.scheduledAt).getTime() - Date.now();
        await followupQueue.add('followup', { followupId: followup._id }, {
            delay,
            jobId: `fu-${followup._id}`
        });

        res.status(201).json({
            success: true,
            message: 'Follow-up IA criado com sucesso!',
            data: followup,
            meta: {
                amandaVersion: '2.0',
                score,
                optimalTime
            }
        });
    } catch (err) {
        console.error("❌ Erro ao criar follow-up IA:", err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * ♻️ Reenviar follow-up
 * POST /api/followups/resend/:id
 */
export const resendFollowup = async (req, res) => {
    try {
        const { id } = req.params;
        const followup = await Followup.findById(id).populate('lead');
        if (!followup) return res.status(404).json({ error: 'Follow-up não encontrado' });

        if (!followup.lead?.contact?.phone)
            return res.status(400).json({ error: 'Lead sem telefone' });

        // ✅ Adicionar na fila novamente
        await followupQueue.add('followup', { followupId: id }, {
            jobId: `fu-resend-${id}-${Date.now()}`
        });

        followup.status = 'processing';
        await followup.save();

        res.json({ success: true, message: 'Follow-up reenviado para fila' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// =====================================================================
// 📊 FUNÇÕES ANALÍTICAS (MANTIDAS COMO ESTÃO)
// =====================================================================

export const getFollowupStats = async (req, res) => {
    try {
        const total = await Followup.countDocuments();
        const sent = await Followup.countDocuments({ status: "sent" });
        const failed = await Followup.countDocuments({ status: "failed" });
        const scheduled = await Followup.countDocuments({ status: "scheduled" });
        const processing = await Followup.countDocuments({ status: "processing" });
        const responded = await Followup.countDocuments({ responded: true });
        const aiOptimized = await Followup.countDocuments({ aiOptimized: true });

        const conversionRate = total ? ((responded / total) * 100).toFixed(1) : 0;
        const aiConversionCount = await Followup.countDocuments({ aiOptimized: true, responded: true });
        const aiConversionRate = aiOptimized ? ((aiConversionCount / aiOptimized) * 100).toFixed(1) : 0;

        const bestHours = await Followup.aggregate([
            { $match: { status: "sent" } },
            { $project: { hour: { $hour: { date: "$sentAt", timezone: "America/Sao_Paulo" } } } },
            { $group: { _id: "$hour", total: { $sum: 1 }, responded: { $sum: { $cond: [{ $eq: ["$responded", true] }, 1, 0] } } } },
            { $project: { hour: "$_id", total: 1, responseRate: { $multiply: [{ $divide: ["$responded", "$total"] }, 100] } } },
            { $sort: { responseRate: -1 } },
            { $limit: 1 },
        ]);

        const bestDays = await Followup.aggregate([
            { $match: { status: "sent" } },
            { $project: { weekday: { $dayOfWeek: { date: "$sentAt", timezone: "America/Sao_Paulo" } } } },
            { $group: { _id: "$weekday", total: { $sum: 1 }, responded: { $sum: { $cond: [{ $eq: ["$responded", true] }, 1, 0] } } } },
            { $project: { weekday: "$_id", total: 1, responseRate: { $multiply: [{ $divide: ["$responded", "$total"] }, 100] } } },
            { $sort: { responseRate: -1 } },
            { $limit: 1 },
        ]);

        const weekdayNames = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
        const bestHour = bestHours[0]?.hour ?? "-";
        const bestDay = weekdayNames[(bestDays[0]?.weekday ?? 1) - 1];

        const aiPerformance = await Followup.aggregate([
            { $match: { aiOptimized: true, status: "sent" } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    responded: { $sum: { $cond: [{ $eq: ["$responded", true] }, 1, 0] } },
                    avgResponseTime: { $avg: "$responseTimeMinutes" }
                }
            }
        ]);

        const aiData = aiPerformance[0] || { total: 0, responded: 0, avgResponseTime: 0 };
        const aiEffectiveness = aiData.total && total ?
            ((aiData.responded / aiData.total) / (responded / total) * 100).toFixed(1) : 0;

        res.json({
            success: true,
            data: {
                total,
                sent,
                failed,
                scheduled,
                processing,
                responded,
                aiOptimized,
                conversionRate,
                aiConversionRate,
                bestHour: bestHour !== "-" ? `${bestHour}h` : "-",
                bestDay,
                aiPerformance: aiData,
                insights: {
                    aiEffectiveness,
                    recommendedStrategy: bestHour !== "-" ? `Focar nos horários das ${bestHour}h` : 'Coletar mais dados'
                }
            },
        });
    } catch (err) {
        console.error("Erro ao gerar estatísticas:", err);
        res.status(500).json({ error: "Erro ao gerar estatísticas de follow-ups" });
    }
};

// Manter todas as outras funções analíticas
export const computeFollowupStats = async () => {
    try {
        const since = new Date();
        since.setDate(since.getDate() - 30);

        const pipeline = [
            { $match: { createdAt: { $gte: since } } },
            { $group: { _id: "$status", total: { $sum: 1 } } },
        ];

        const data = await Followup.aggregate(pipeline);
        return data.reduce((acc, d) => ({ ...acc, [d._id]: d.total }), {});
    } catch (err) {
        console.error("Erro ao calcular estatísticas:", err);
        return {};
    }
};

export const getAllFollowups = async (req, res) => {
    try {
        const followups = await Followup.find()
            .populate('lead', 'name contact.phone')
            .sort({ createdAt: -1 })
            .limit(100);
        res.json({ success: true, data: followups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

export const getPendingFollowups = async (req, res) => {
    try {
        const pending = await Followup.find({ status: 'scheduled' })
            .populate('lead', 'name contact.phone')
            .sort({ scheduledAt: 1 });
        res.json({ success: true, data: pending });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

export const getFollowupHistory = async (req, res) => {
    try {
        const leadId = req.params.leadId || req.query.leadId;
        
        if (!leadId) {
            return res.status(400).json({ 
                success: false, 
                message: "leadId é obrigatório" 
            });
        }

        const history = await Followup.find({ lead: leadId })
            .populate('lead', 'name contact.phone')
            .sort({ createdAt: -1 });

        res.json({ 
            success: true, 
            data: history,
            count: history.length 
        });
    } catch (err) {
        res.status(500).json({ 
            success: false,
            error: err.message 
        });
    }
};



export const filterFollowups = async (req, res) => {
    try {
        const { status, startDate, endDate, origin } = req.query;
        const query = {};

        if (status) query.status = status;
        if (origin) query.origin = origin;
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate);
            if (endDate) query.createdAt.$lte = new Date(endDate);
        }

        const followups = await Followup.find(query)
            .populate('lead', 'name contact.phone origin')
            .sort({ createdAt: -1 });

        res.json({ success: true, data: followups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

export const getFollowupAnalytics = async (req, res) => {
    try {
        const total = await Followup.countDocuments();
        const respondedCount = await Followup.countDocuments({ responded: true });

        const avgResponse = await Followup.aggregate([
            { $match: { responded: true, responseTimeMinutes: { $exists: true } } },
            { $group: { _id: null, avgResponseTime: { $avg: "$responseTimeMinutes" } } },
        ]);

        const topChannels = await Followup.aggregate([
            { $group: { _id: "$origin", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 },
        ]);

        const bestHours = await Followup.aggregate([
            { $project: { hour: { $hour: { date: "$scheduledAt", timezone: "America/Sao_Paulo" } } } },
            { $group: { _id: "$hour", total: { $sum: 1 } } },
            { $sort: { total: -1 } },
            { $limit: 1 },
        ]);

        const bestDays = await Followup.aggregate([
            { $project: { weekday: { $dayOfWeek: { date: "$scheduledAt", timezone: "America/Sao_Paulo" } } } },
            { $group: { _id: "$weekday", total: { $sum: 1 } } },
            { $sort: { total: -1 } },
            { $limit: 1 },
        ]);

        const weekdayNames = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
        const bestHour = bestHours[0]?._id ?? null;
        const bestDay = weekdayNames[(bestDays[0]?._id ?? 1) - 1];

        res.json({
            success: true,
            data: {
                total,
                responded: respondedCount,
                avgResponseTime: Math.round(avgResponse[0]?.avgResponseTime || 0),
                topChannels: topChannels.reduce(
                    (acc, c) => ({ ...acc, [c._id || "desconhecido"]: c.count }),
                    {}
                ),
                bestHour: bestHour !== null ? `${bestHour}h` : "-",
                bestDay: bestDay || "-",
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro ao gerar analytics de follow-ups" });
    }
};

export const getFollowupTrend = async (req, res) => {
    try {
        const days = parseInt(req.query.days || 7);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const trend = await Followup.aggregate([
            { $match: { createdAt: { $gte: since } } },
            {
                $group: {
                    _id: { $dateToString: { format: "%d/%m", date: "$createdAt" } },
                    sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
                    failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                    responded: { $sum: { $cond: [{ $eq: ["$responded", true] }, 1, 0] } },
                },
            },
            { $sort: { _id: 1 } },
        ]);

        res.json({ success: true, data: trend });
    } catch (err) {
        res.status(500).json({ error: "Erro ao gerar tendência", details: err.message });
    }
};

export const getFollowupConversionByOrigin = async (req, res) => {
    try {
        const data = await Followup.aggregate([
            {
                $lookup: {
                    from: "leads",
                    localField: "lead",
                    foreignField: "_id",
                    as: "leadData",
                },
            },
            { $unwind: "$leadData" },
            {
                $group: {
                    _id: "$leadData.origin",
                    total: { $sum: 1 },
                    responded: { $sum: { $cond: [{ $eq: ["$responded", true] }, 1, 0] } },
                },
            },
            {
                $project: {
                    origin: "$_id",
                    total: 1,
                    responded: 1,
                    conversionRate: {
                        $round: [{ $multiply: [{ $divide: ["$responded", "$total"] }, 100] }, 1],
                    },
                    _id: 0,
                },
            },
            { $sort: { conversionRate: -1 } },
        ]);

        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: "Erro ao gerar conversão por origem", details: err.message });
    }
};

export const getAvgResponseTime = async (req, res) => {
    try {
        const responded = await Followup.find({
            responded: true,
            sentAt: { $exists: true },
            respondedAt: { $exists: true },
        });

        if (!responded.length)
            return res.json({ success: true, data: { avgMinutes: 0 } });

        const avgMs =
            responded.reduce((sum, f) => {
                const sent = new Date(f.sentAt).getTime();
                const resp = new Date(f.respondedAt).getTime();
                return sum + (resp - sent);
            }, 0) / responded.length;

        const avgMinutes = Math.round(avgMs / 60000);
        res.json({ success: true, data: { avgMinutes } });
    } catch (err) {
        res.status(500).json({ error: "Erro ao calcular tempo médio", details: err.message });
    }
};