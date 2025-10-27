import { followupQueue } from "../config/bullConfig.js";
import Followup from '../models/Followup.js';
import Lead from '../models/Leads.js';
import { generateFollowupMessage } from "../services/aiAmandaService.js";

/**
 * 🧩 Agendar novo follow-up (com Amanda AI)
 */
export const scheduleFollowup = async (req, res) => {
    try {
        const { leadId, message, scheduledAt, aiOptimized = false, context } = req.body;

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

        // 🎯 SE SOLICITADO, AMANDA GERA MENSAGEM INTELIGENTE
        if (aiOptimized || !message?.trim()) {
            try {
                finalMessage = await generateFollowupMessage(lead);
                console.log(`🤖 Amanda gerou mensagem para lead ${lead.name}`);
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
            context: context || {},
            processingMetadata: {
                originalMessage: message,
                aiGenerated: aiOptimized || !message?.trim(),
                scheduledBy: req.user?.id || 'system'
            }
        });

        await followupQueue.add('followup', { followupId: followup._id }, { delay });

        res.status(201).json({
            success: true,
            message: 'Follow-up agendado com sucesso!',
            data: followup,
        });
    } catch (err) {
        console.error("❌ Erro ao agendar follow-up:", err);
        res.status(500).json({ error: err.message });
    }
};


/**
 * 🧠 Criar follow-up inteligente com Amanda AI
 */
export const createAIFollowup = async (req, res) => {
    try {
        const { leadId, scheduledAt, context = {}, objective } = req.body;

        if (!leadId) return res.status(400).json({ error: 'leadId é obrigatório' });

        const lead = await Lead.findById(leadId);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        // 🎯 AMANDA GERA MENSAGEM CONTEXTUAL
        const message = await generateFollowupMessage(lead);

        const followup = await Followup.create({
            lead: leadId,
            message,
            scheduledAt: scheduledAt || new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 horas padrão
            status: 'scheduled',
            aiOptimized: true,
            context: {
                objective: objective || 'reengajamento',
                leadStage: lead.stage,
                previousInteractions: lead.interactionCount || 0,
                ...context
            },
            processingMetadata: {
                aiVersion: '1.0',
                generatedAt: new Date(),
                strategy: 'contextual_followup'
            }
        });

        const delay = new Date(followup.scheduledAt).getTime() - Date.now();
        await followupQueue.add('followup', { followupId: followup._id }, { delay });

        res.status(201).json({
            success: true,
            message: 'Follow-up IA criado com sucesso!',
            data: followup
        });
    } catch (err) {
        console.error("❌ Erro ao criar follow-up IA:", err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * 📊 Estatísticas de follow-ups (com insights de IA)
 */
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

        // 🔍 Dados complementares para Insights
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

        // 🧠 Insights da Amanda AI
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

export const computeFollowupStats = async () => {
    try {
        const since = new Date();
        since.setDate(since.getDate() - 30);

        const pipeline = [
            { $match: { createdAt: { $gte: since } } },
            { $group: { _id: "$status", total: { $sum: 1 } } },
        ];

        const data = await Followup.aggregate(pipeline);

        const total = data.reduce((acc, d) => acc + d.total, 0);
        const sent = data.find(d => d._id === "sent")?.total || 0;
        const failed = data.find(d => d._id === "failed")?.total || 0;
        const scheduled = data.find(d => d._id === "scheduled")?.total || 0;
        const processing = data.find(d => d._id === "processing")?.total || 0;

        return {
            total,
            sent,
            failed,
            scheduled,
            processing,
            successRate: total ? ((sent / total) * 100).toFixed(1) : 0,
        };
    } catch (err) {
        console.error("❌ Erro computeFollowupStats:", err);
        return {
            total: 0, sent: 0, failed: 0, scheduled: 0, processing: 0, successRate: 0,
        };
    }
};

/**
 * 📈 Analytics com inteligência da Amanda
 */
export const getAIFollowupAnalytics = async (req, res) => {
    try {
        // 🛠️ CORREÇÃO: Usar as funções diretamente em vez de req.query
        const basicStats = await computeFollowupStats();
        const trendData = await getFollowupTrend(req); // Passar o req para a função
        const originData = await getFollowupConversionByOrigin(req); // Passar o req para a função

        // 🧠 Análise de performance da IA
        const aiAnalysis = await Followup.aggregate([
            { $match: { status: "sent" } },
            {
                $group: {
                    _id: "$aiOptimized",
                    total: { $sum: 1 },
                    responded: { $sum: { $cond: [{ $eq: ["$responded", true] }, 1, 0] } },
                    avgResponseTime: { $avg: "$responseTimeMinutes" }
                }
            }
        ]);

        const manualStats = aiAnalysis.find(a => a._id === false) || { total: 0, responded: 0 };
        const aiStats = aiAnalysis.find(a => a._id === true) || { total: 0, responded: 0 };

        res.json({
            success: true,
            data: {
                ...basicStats,
                trends: trendData.data,
                conversionByOrigin: originData.data,
                aiPerformance: {
                    manual: {
                        total: manualStats.total,
                        responded: manualStats.responded,
                        conversionRate: manualStats.total ? ((manualStats.responded / manualStats.total) * 100).toFixed(1) : 0
                    },
                    ai: {
                        total: aiStats.total,
                        responded: aiStats.responded,
                        conversionRate: aiStats.total ? ((aiStats.responded / aiStats.total) * 100).toFixed(1) : 0
                    },
                    improvement: aiStats.total && manualStats.total ?
                        (((aiStats.responded / aiStats.total) - (manualStats.responded / manualStats.total)) * 100).toFixed(1) : 0
                },
                recommendations: generateAIRecommendations(aiStats, manualStats)
            }
        });
    } catch (err) {
        console.error("Erro ao gerar analytics IA:", err);
        res.status(500).json({ error: "Erro ao gerar analytics inteligentes" });
    }
};

/**
 * 🎯 Gera recomendações baseadas em dados
 */
function generateAIRecommendations(aiStats, manualStats) {
    const recommendations = [];

    const aiConversion = aiStats.total ? (aiStats.responded / aiStats.total) : 0;
    const manualConversion = manualStats.total ? (manualStats.responded / manualStats.total) : 0;

    if (aiConversion > manualConversion + 0.1) { // 10% melhor
        recommendations.push("Continue usando a Amanda AI - performance superior detectada");
    }

    if (aiStats.total < manualStats.total * 0.3) { // Poucos follow-ups IA
        recommendations.push("Aumente o uso de follow-ups com IA para melhorar engajamento");
    }

    if (aiStats.total > 0 && manualStats.total > 0) {
        recommendations.push(`IA é ${((aiConversion / manualConversion - 1) * 100).toFixed(1)}% mais eficaz que follow-ups manuais`);
    }

    return recommendations.length > 0 ? recommendations : ["Continue coletando dados para insights mais precisos"];
}

/**
 * 🔎 Listar todos os follow-ups
 */
export const getAllFollowups = async (req, res) => {
    try {
        const followups = await Followup.find()
            .populate('lead')
            .sort({ scheduledAt: 1 });
        res.json(followups);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao listar follow-ups' });
    }
};

/**
 * ⏳ Listar pendentes (agendados futuros)
 */
export const getPendingFollowups = async (req, res) => {
    try {
        const now = new Date();
        const followups = await Followup.find({
            status: 'scheduled',
            scheduledAt: { $gte: now },
        })
            .populate('lead')
            .sort({ scheduledAt: 1 });

        res.json(followups);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao listar pendentes' });
    }
};

/**
 * 📜 Histórico (enviados e falhados)
 */
export const getFollowupHistory = async (req, res) => {
    try {
        const followups = await Followup.find({
            status: { $in: ['sent', 'failed'] },
        })
            .populate('lead')
            .sort({ updatedAt: -1 })
            .limit(20);

        res.json(followups);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao listar histórico' });
    }
};

/**
 * 🔍 Filtrar follow-ups
 */
export const filterFollowups = async (req, res) => {
    try {
        const { status, startDate, endDate, origin } = req.query;
        const query = {};

        if (status) query.status = status;
        if (origin) query.origin = origin;
        if (startDate || endDate) {
            query.scheduledAt = {};
            if (startDate) query.scheduledAt.$gte = new Date(startDate);
            if (endDate) query.scheduledAt.$lte = new Date(endDate);
        }

        const followups = await Followup.find(query)
            .populate('lead')
            .sort({ scheduledAt: -1 });

        res.json({ success: true, data: followups });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};


/**
 * 🔁 Reenviar follow-up falhado
 */
export const resendFollowup = async (req, res) => {
    try {
        const { id } = req.params;
        const followup = await Followup.findById(id).populate('lead');
        if (!followup) return res.status(404).json({ error: 'Follow-up não encontrado' });

        if (!followup.lead?.contact?.phone)
            return res.status(400).json({ error: 'Lead sem telefone' });

        // 🛠️ CORREÇÃO: Usar 'followup' em vez de 'sendFollowup' para consistência
        await followupQueue.add('followup', { followupId: id });
        followup.status = 'processing';
        await followup.save();

        res.json({ success: true, message: 'Follow-up reenviado para fila' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};


/**
 * 📊 Endpoint analítico de follow-ups
 * GET /followups/analytics
 */
export const getFollowupAnalytics = async (req, res) => {
    try {
        // total de follow-ups
        const total = await Followup.countDocuments();

        // respondidos
        const respondedCount = await Followup.countDocuments({ responded: true });

        // tempo médio de resposta (em minutos)
        const avgResponse = await Followup.aggregate([
            { $match: { responded: true, responseTimeMinutes: { $exists: true } } },
            { $group: { _id: null, avgResponseTime: { $avg: "$responseTimeMinutes" } } },
        ]);

        // canais mais usados
        const topChannels = await Followup.aggregate([
            { $group: { _id: "$channel", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 },
        ]);

        // melhores horários de envio (hora do dia)
        const bestHours = await Followup.aggregate([
            { $project: { hour: { $hour: { date: "$scheduledAt", timezone: "America/Sao_Paulo" } } } },
            { $group: { _id: "$hour", total: { $sum: 1 } } },
            { $sort: { total: -1 } },
            { $limit: 1 },
        ]);

        // melhores dias da semana
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

// =======================
// 📊 1. Tendência temporal (últimos 7 dias)
// =======================
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
                    responded: { $sum: { $cond: [{ $eq: ["$status", "responded"] }, 1, 0] } },
                },
            },
            { $sort: { _id: 1 } },
        ]);

        res.json({ success: true, data: trend });
    } catch (err) {
        res.status(500).json({ error: "Erro ao gerar tendência", details: err.message });
    }
};

// =======================
// 🥧 2. Conversão por origem de lead
// =======================
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
                    responded: { $sum: { $cond: [{ $eq: ["$status", "responded"] }, 1, 0] } },
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

// =======================
// ⏱ 3. Tempo médio até resposta
// =======================
export const getAvgResponseTime = async (req, res) => {
    try {
        const responded = await Followup.find({
            status: "responded",
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

export const createFollowup = async (req, res) => {
    try {
        const lead = await Lead.findById(req.body.lead);
        if (!lead) return res.status(404).json({ success: false, message: "Lead não encontrado" });

        let message = req.body.message;

        // ✨ Se a mensagem estiver vazia, Amanda cria automaticamente
        if (!message || message.trim() === "") {
            message = await generateFollowupMessage(lead);
        }

        const followup = await Followup.create({
            lead: lead._id,
            message,
            scheduledAt: req.body.scheduledAt || new Date(),
            status: "scheduled",
            playbook: req.body.playbook || null,
            note: req.body.note || "",
        });

        res.json({ success: true, data: followup });
    } catch (err) {
        console.error("❌ Erro ao criar follow-up:", err);
        res.status(500).json({ success: false, error: err.message });
    }
};


