import { Queue } from 'bullmq';
import Followup from '../models/Followup.js';
import Lead from '../models/Leads.js';
import { generateFollowupMessage } from "../services/amandaService.js";

const followupQueue = new Queue('followupQueue', {
    connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
    },
});

/**
 * 🧩 Agendar novo follow-up
 */
export const scheduleFollowup = async (req, res) => {
    try {
        const { leadId, message, scheduledAt } = req.body;

        if (!leadId || !message || !scheduledAt)
            return res
                .status(400)
                .json({ error: 'Campos obrigatórios: leadId, message, scheduledAt' });

        const lead = await Lead.findById(leadId);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
        if (!lead.contact?.phone)
            return res.status(400).json({ error: 'Lead sem telefone cadastrado' });

        const delay = new Date(scheduledAt).getTime() - Date.now();
        if (delay < 0)
            return res.status(400).json({ error: 'Data/hora precisa ser futura' });

        const followup = await Followup.create({
            lead: leadId,
            message,
            scheduledAt,
            status: 'scheduled',
        });

        await followupQueue.add('followup', { followupId: followup._id }, { delay });

        res.status(201).json({
            success: true,
            message: 'Follow-up agendado com sucesso!',
            data: followup,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

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
 * 📊 Estatísticas de follow-ups
 */
export const getFollowupStats = async (req, res) => {
  try {
    const total = await Followup.countDocuments();
    const sent = await Followup.countDocuments({ status: "sent" });
    const failed = await Followup.countDocuments({ status: "failed" });
    const scheduled = await Followup.countDocuments({ status: "scheduled" });
    const processing = await Followup.countDocuments({ status: "processing" });
    const responded = await Followup.countDocuments({ responded: true });

    const conversionRate = total ? ((responded / total) * 100).toFixed(1) : 0;

    // 🔍 dados complementares para Insights
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
    const bestHour = bestHours[0]?._id ?? "-";
    const bestDay = weekdayNames[(bestDays[0]?._id ?? 1) - 1];

    res.json({
      success: true,
      data: {
        total,
        sent,
        failed,
        scheduled,
        processing,
        responded,
        conversionRate,
        bestHour: bestHour !== "-" ? `${bestHour}h` : "-",
        bestDay,
      },
    });
  } catch (err) {
    console.error("Erro ao gerar estatísticas:", err);
    res.status(500).json({ error: "Erro ao gerar estatísticas de follow-ups" });
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

        await followupQueue.add('sendFollowup', { followupId: id });
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

