// routes/analytics/roi.routes.js
// 🚀 ROI por origem — conecta Lead → Patient → Appointment → Receita

import express from 'express';
import mongoose from 'mongoose';
import Lead from '../../models/Leads.js';
import { flexibleAuth } from '../../middleware/amandaAuth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

const router = express.Router();

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
                            $expr: { $eq: ['$patient', '$$patientId'] },
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

export default router;
