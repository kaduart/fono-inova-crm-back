// routes/analytics/roi.routes.js
// 🚀 ROI por origem — conecta Lead → Patient → Appointment → Receita

import express from 'express';
import mongoose from 'mongoose';
import Lead from '../../models/Leads.js';
import LeadAttribution from '../../models/LeadAttribution.js';
import AdConversion from '../../models/AdConversion.js';
import AdSpend from '../../models/AdSpend.js';
import { flexibleAuth } from '../../middleware/amandaAuth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

const router = express.Router();

// Cache simples em memória — evita aggregation pesada a cada request
const _cache = new Map(); // key → { data, summary, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * GET /api/v2/analytics/roi-by-source
 *
 * Retorna métricas de conversão e receita por origem de lead.
 *
 * Query params opcionais:
 *   - startDate (YYYY-MM-DD)
 *   - endDate   (YYYY-MM-DD)
 *   - doctorId  (filtrar por profissional)
 */
router.get('/roi-by-source', flexibleAuth, asyncHandler(async (req, res) => {
    const { startDate, endDate, doctorId } = req.query;

    // Retorna cache se ainda válido (apenas para queries sem filtros — o caso mais comum do dashboard)
    if (!startDate && !endDate && !doctorId) {
        const cached = _cache.get('roi-by-source');
        if (cached && Date.now() < cached.expiresAt) {
            return res.json({ success: true, data: cached.data, summary: cached.summary, meta: { fromCache: true, timestamp: cached.ts } });
        }
    }

    const matchStage = {};

    // Filtro de período (criação do lead)
    if (startDate || endDate) {
        matchStage.createdAt = {};
        if (startDate) matchStage.createdAt.$gte = new Date(startDate + 'T00:00:00.000Z');
        if (endDate) matchStage.createdAt.$lte = new Date(endDate + 'T23:59:59.999Z');
    }

    // Filtro de profissional (via appointments futuros)
    // Nota: doctorId filtra os leads que geraram appointments para aquele médico
    const appointmentMatch = {
        operationalStatus: { $nin: ['canceled', 'cancelado'] }
    };
    if (doctorId) {
        appointmentMatch.doctor = new mongoose.Types.ObjectId(doctorId);
    }

    const pipeline = [
        // 1. Filtra leads
        { $match: matchStage },

        // 2. Lookup Patient (conversão)
        {
            $lookup: {
                from: 'patients',
                localField: 'convertedToPatient',
                foreignField: '_id',
                as: 'patient'
            }
        },
        { $unwind: { path: '$patient', preserveNullAndEmptyArrays: true } },

        // 3. Lookup Appointments do patient
        {
            $lookup: {
                from: 'appointments',
                let: { patientId: '$patient._id' },
                pipeline: [
                    {
                        $match: {
                            // Sem o guard, lead não convertido (patientId ausente) casa com
                            // agendamentos sem `patient` (missing == missing) e infla "Agend."/receita.
                            $expr: { $and: [{ $ne: [{ $ifNull: ['$$patientId', null] }, null] }, { $eq: ['$patient', '$$patientId'] }] },
                            ...appointmentMatch
                        }
                    },
                    {
                        $project: {
                            sessionValue: { $ifNull: ['$sessionValue', 0] },
                            operationalStatus: 1,
                            date: 1
                        }
                    }
                ],
                as: 'appointments'
            }
        },

        // 4. Campos calculados por lead
        {
            $addFields: {
                converted: { $cond: [{ $ifNull: ['$patient._id', false] }, 1, 0] },
                revenue: {
                    $sum: {
                        $map: {
                            input: '$appointments',
                            as: 'appt',
                            in: '$$appt.sessionValue'
                        }
                    }
                },
                appointmentCount: { $size: '$appointments' }
            }
        },

        // 5. Agrupa por origem
        {
            $group: {
                _id: { $ifNull: ['$origin', 'desconhecido'] },
                totalLeads: { $sum: 1 },
                totalConverted: { $sum: '$converted' },
                totalRevenue: { $sum: '$revenue' },
                totalAppointments: { $sum: '$appointmentCount' }
            }
        },

        // 6. Taxa de conversão
        {
            $addFields: {
                conversionRate: {
                    $cond: [
                        { $eq: ['$totalLeads', 0] },
                        0,
                        { $round: [{ $divide: ['$totalConverted', '$totalLeads'] }, 4] }
                    ]
                },
                avgRevenuePerLead: {
                    $cond: [
                        { $eq: ['$totalLeads', 0] },
                        0,
                        { $round: [{ $divide: ['$totalRevenue', '$totalLeads'] }, 2] }
                    ]
                }
            }
        },

        // 7. Formata resposta
        {
            $project: {
                _id: 0,
                origin: '$_id',
                totalLeads: 1,
                totalConverted: 1,
                conversionRate: 1,
                totalAppointments: 1,
                totalRevenue: 1,
                avgRevenuePerLead: 1
            }
        },

        // 8. Ordena por receita (maior primeiro)
        { $sort: { totalRevenue: -1 } }
    ];

    const data = await Lead.aggregate(pipeline);

    // Resumo geral (totais)
    const summary = data.reduce(
        (acc, item) => ({
            totalLeads: acc.totalLeads + item.totalLeads,
            totalConverted: acc.totalConverted + item.totalConverted,
            totalRevenue: acc.totalRevenue + item.totalRevenue,
            totalAppointments: acc.totalAppointments + item.totalAppointments
        }),
        { totalLeads: 0, totalConverted: 0, totalRevenue: 0, totalAppointments: 0 }
    );

    summary.overallConversionRate =
        summary.totalLeads === 0
            ? 0
            : Math.round((summary.totalConverted / summary.totalLeads) * 10000) / 10000;

    // Salva no cache (apenas para queries sem filtros)
    if (!startDate && !endDate && !doctorId) {
        _cache.set('roi-by-source', { data, summary, expiresAt: Date.now() + CACHE_TTL_MS, ts: new Date().toISOString() });
    }

    return res.json({
        success: true,
        data,
        summary,
        meta: {
            filters: { startDate, endDate, doctorId },
            timestamp: new Date().toISOString()
        }
    });
}));

/**
 * GET /api/v2/analytics/roi/acquisition?days=30
 * Funil por canal a partir da atribuição automática (WhatsApp):
 * conversas iniciadas → 1º agendamento → receita → enviado às plataformas.
 */
router.get('/acquisition', flexibleAuth, asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 864e5);

    const [convs, appts] = await Promise.all([
        LeadAttribution.aggregate([
            { $match: { firstMessageAt: { $gte: since } } },
            { $group: { _id: '$source', conversations: { $sum: 1 } } },
        ]),
        AdConversion.aggregate([
            { $match: { eventTime: { $gte: since }, 'meta.reason': { $ne: 'nao_e_primeiro_agendamento' } } },
            { $group: {
                _id: '$source',
                firstAppointments: { $sum: 1 },
                revenue: { $sum: '$value' },
                sentMeta: { $sum: { $cond: [{ $eq: ['$meta.status', 'sent'] }, 1, 0] } },
                sentGoogle: { $sum: { $cond: [{ $eq: ['$google.status', 'sent'] }, 1, 0] } },
            } },
        ]),
    ]);

    const map = new Map();
    for (const c of convs) map.set(c._id || 'unknown', { source: c._id || 'unknown', conversations: c.conversations, firstAppointments: 0, revenue: 0, sentMeta: 0, sentGoogle: 0 });
    for (const a of appts) {
        const k = a._id || 'unknown';
        const row = map.get(k) || { source: k, conversations: 0 };
        map.set(k, { ...row, firstAppointments: a.firstAppointments, revenue: a.revenue, sentMeta: a.sentMeta, sentGoogle: a.sentGoogle });
    }
    const data = [...map.values()]
        .map((r) => ({ ...r, bookingRate: r.conversations ? +(r.firstAppointments / r.conversations).toFixed(4) : null }))
        .sort((x, y) => y.firstAppointments - x.firstAppointments || y.conversations - x.conversations);

    const totals = data.reduce((t, r) => ({
        conversations: t.conversations + (r.conversations || 0),
        firstAppointments: t.firstAppointments + (r.firstAppointments || 0),
        revenue: t.revenue + (r.revenue || 0),
    }), { conversations: 0, firstAppointments: 0, revenue: 0 });

    res.json({ success: true, days, data, totals });
}));

/**
 * GET /api/v2/analytics/roi/acquisition-by-ad?days=30
 * Mesma lógica do funil por canal, aberta POR ANÚNCIO: conversas → 1º agendamento → valor.
 * Chave = ID do anúncio (WhatsApp/ctwa); sem ele, a campanha do link do site (---ref).
 * Quando o link do site passar o ID do anúncio no campo de campanha, separa sozinho por anúncio.
 */
router.get('/acquisition-by-ad', flexibleAuth, asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 864e5);
    const key = { $ifNull: [{ $cond: [{ $in: ['$adId', [null, '']] }, null, '$adId'] }, { $cond: [{ $in: ['$campaign', [null, '']] }, null, '$campaign'] }] };

    const [convs, appts, spends] = await Promise.all([
        LeadAttribution.aggregate([
            { $match: { firstMessageAt: { $gte: since } } },
            { $addFields: { adKey: key } },
            { $match: { adKey: { $ne: null } } },
            { $group: { _id: '$adKey', conversations: { $sum: 1 }, source: { $max: '$source' }, adTitle: { $max: '$adTitle' }, isCtwa: { $max: { $cond: [{ $eq: ['$method', 'ctwa'] }, 1, 0] } }, isToken: { $max: { $cond: [{ $eq: ['$method', 'token'] }, 1, 0] } }, lastAt: { $max: '$firstMessageAt' } } },
        ]),
        AdConversion.aggregate([
            { $match: { eventTime: { $gte: since }, 'meta.reason': { $ne: 'nao_e_primeiro_agendamento' } } },
            { $addFields: { adKey: key } },
            { $match: { adKey: { $ne: null } } },
            { $group: { _id: '$adKey', firstAppointments: { $sum: 1 }, revenue: { $sum: '$value' } } },
        ]),
        AdSpend.aggregate([
            { $match: { date: { $gte: since } } },
            { $group: { _id: '$adKey', spend: { $sum: '$amount' } } },
        ]),
    ]);

    const map = new Map();
    for (const c of convs) map.set(c._id, { adKey: c._id, kind: c.isCtwa ? 'whatsapp_ad' : (c.isToken ? 'text_tag' : 'site_link'), source: c.source, adTitle: c.adTitle || null, conversations: c.conversations, firstAppointments: 0, revenue: 0, spend: 0, lastAt: c.lastAt });
    for (const a of appts) {
        const row = map.get(a._id) || { adKey: a._id, kind: 'site_link', source: null, adTitle: null, conversations: 0, spend: 0, lastAt: null };
        map.set(a._id, { ...row, firstAppointments: a.firstAppointments, revenue: a.revenue });
    }
    for (const s of spends) {
        const row = map.get(s._id);
        if (row) row.spend = s.spend; // gasto só aparece em linhas que existem (anúncio com conversa ou agendamento)
    }
    const r2 = (n) => +n.toFixed(2);
    const data = [...map.values()]
        .map((r) => ({
            ...r,
            spend: r2(r.spend || 0),
            bookingRate: r.conversations ? +(r.firstAppointments / r.conversations).toFixed(4) : null,
            // Custos só existem quando há gasto informado e o denominador > 0
            costPerConversation: r.spend > 0 && r.conversations ? r2(r.spend / r.conversations) : null,
            costPerAppointment: r.spend > 0 && r.firstAppointments ? r2(r.spend / r.firstAppointments) : null,
        }))
        .sort((x, y) => y.firstAppointments - x.firstAppointments || y.conversations - x.conversations);

    const totals = data.reduce((t, r) => ({
        conversations: t.conversations + (r.conversations || 0),
        firstAppointments: t.firstAppointments + (r.firstAppointments || 0),
        revenue: t.revenue + (r.revenue || 0),
        spend: t.spend + (r.spend || 0),
    }), { conversations: 0, firstAppointments: 0, revenue: 0, spend: 0 });
    totals.spend = r2(totals.spend);

    res.json({ success: true, days, data, totals });
}));

/**
 * POST /api/v2/analytics/roi/acquisition-by-ad/spend   { adKey, amount, date? }
 * Lança gasto (R$) de um anúncio/campanha. Entradas somam no período; "desfazer" remove a última.
 */
router.post('/acquisition-by-ad/spend', flexibleAuth, asyncHandler(async (req, res) => {
    const adKey = String(req.body?.adKey || '').trim();
    const amount = Number(String(req.body?.amount ?? '').replace(',', '.'));
    if (!adKey || adKey.length > 200) return res.status(400).json({ success: false, error: 'adKey inválido' });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return res.status(400).json({ success: false, error: 'amount deve ser entre 0,01 e 1.000.000' });
    const date = req.body?.date ? new Date(req.body.date) : new Date();
    if (Number.isNaN(date.getTime())) return res.status(400).json({ success: false, error: 'date inválida' });

    const doc = await AdSpend.create({ adKey, amount, date, createdBy: req.user?.email || req.user?._id?.toString?.() || null });
    res.status(201).json({ success: true, id: doc._id, adKey, amount, date });
}));

/** DELETE /api/v2/analytics/roi/acquisition-by-ad/spend/last?adKey=...  — desfaz o último lançamento do anúncio */
router.delete('/acquisition-by-ad/spend/last', flexibleAuth, asyncHandler(async (req, res) => {
    const adKey = String(req.query?.adKey || '').trim();
    if (!adKey) return res.status(400).json({ success: false, error: 'adKey obrigatório' });
    const last = await AdSpend.findOneAndDelete({ adKey }, { sort: { createdAt: -1 } });
    if (!last) return res.status(404).json({ success: false, error: 'Nenhum lançamento para desfazer' });
    res.json({ success: true, removed: { id: last._id, amount: last.amount } });
}));

export default router;
