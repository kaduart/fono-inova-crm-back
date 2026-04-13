// routes/analytics/operational.routes.js
// Dashboard operacional - calculado via aggregate direto (sem worker)

import express from 'express';
import moment from 'moment-timezone';
import { auth, authorize } from '../../middleware/auth.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Package from '../../models/Package.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * @route   GET /api/v2/analytics/operational
 * @desc    Dashboard operacional: agendamentos, sessões, produtividade
 * @access  Admin/Secretary
 */
router.get('/', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { date, period = 'month', doctorId } = req.query;
        
        // Define período
        const targetDate = date 
            ? moment.tz(date, TIMEZONE) 
            : moment.tz(TIMEZONE);
        
        const start = targetDate.clone().startOf(period).toDate();
        const end = targetDate.clone().endOf(period).toDate();
        const dateStr = targetDate.format('YYYY-MM-DD');

        // ======================================================
        // 📅 APPOINTMENTS - Métricas de agendamento
        // ======================================================
        const appointmentMatch = {
            date: { $gte: start, $lte: end },
            appointmentId: { $exists: false }
        };
        if (doctorId) appointmentMatch.doctor = doctorId;

        const appointmentStats = await Appointment.aggregate([
            { $match: appointmentMatch },
            {
                $group: {
                    _id: null,
                    scheduled: { $sum: 1 },
                    completed: {
                        $sum: { $cond: [{ $eq: ['$clinicalStatus', 'completed'] }, 1, 0] }
                    },
                    canceled: {
                        $sum: { $cond: [{ $eq: ['$operationalStatus', 'canceled'] }, 1, 0] }
                    },
                    noShow: {
                        $sum: { $cond: [{ $eq: ['$operationalStatus', 'missed'] }, 1, 0] }
                    },
                    confirmed: {
                        $sum: { $cond: [{ $eq: ['$operationalStatus', 'confirmed'] }, 1, 0] }
                    }
                }
            }
        ]);

        const a = appointmentStats[0] || { scheduled: 0, completed: 0, canceled: 0, noShow: 0, confirmed: 0 };
        
        // Calcula taxas
        const completionRate = a.scheduled > 0 ? (a.completed / a.scheduled) * 100 : 0;
        const cancellationRate = a.scheduled > 0 ? (a.canceled / a.scheduled) * 100 : 0;
        const noShowRate = a.scheduled > 0 ? (a.noShow / a.scheduled) * 100 : 0;

        // ======================================================
        // 🩺 SESSIONS - Métricas de produção
        // ======================================================
        const sessionMatch = {
            date: { $gte: start, $lte: end }
        };
        if (doctorId) sessionMatch.doctor = doctorId;

        const sessionStats = await Session.aggregate([
            { $match: sessionMatch },
            {
                $group: {
                    _id: null,
                    totalSessions: { $sum: 1 },
                    completedSessions: {
                        $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                    },
                    totalRevenue: {
                        $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$value', 0] }
                    },
                    totalCommission: {
                        $sum: '$commissionValue'
                    }
                }
            }
        ]);

        const s = sessionStats[0] || { 
            totalSessions: 0, 
            completedSessions: 0, 
            totalRevenue: 0,
            totalCommission: 0
        };

        // ======================================================
        // 👨‍⚕️ PRODUÇÃO POR PROFISSIONAL
        // ======================================================
        const productionByDoctor = await Session.aggregate([
            { $match: { ...sessionMatch, status: 'completed' } },
            {
                $group: {
                    _id: '$doctor',
                    sessionsCount: { $sum: 1 },
                    totalRevenue: { $sum: '$value' },
                    totalCommission: { $sum: '$commissionValue' }
                }
            },
            {
                $lookup: {
                    from: 'doctors',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'doctor'
                }
            },
            { $unwind: '$doctor' },
            {
                $project: {
                    doctorId: '$_id',
                    doctorName: '$doctor.fullName',
                    specialty: '$doctor.specialty',
                    sessionsCount: 1,
                    totalRevenue: 1,
                    totalCommission: 1,
                    netRevenue: { $subtract: ['$totalRevenue', '$totalCommission'] }
                }
            },
            { $sort: { totalRevenue: -1 } }
        ]);

        // ======================================================
        // 📦 PACOTES - Métricas de vendas
        // ======================================================
        const packageMatch = {
            createdAt: { $gte: start, $lte: end }
        };
        if (doctorId) packageMatch.doctor = doctorId;

        const packageStats = await Package.aggregate([
            { $match: packageMatch },
            {
                $group: {
                    _id: null,
                    packagesSold: { $sum: 1 },
                    totalValue: { $sum: '$totalValue' },
                    totalPaid: { $sum: '$totalPaid' },
                    totalSessions: { $sum: '$totalSessions' }
                }
            }
        ]);

        const p = packageStats[0] || {
            packagesSold: 0,
            totalValue: 0,
            totalPaid: 0,
            totalSessions: 0
        };

        // ======================================================
        // 📊 MONTAR RESPOSTA
        // ======================================================
        const overview = {
            period: {
                date: dateStr,
                period,
                start: start.toISOString(),
                end: end.toISOString()
            },
            appointments: {
                scheduled: a.scheduled,
                completed: a.completed,
                canceled: a.canceled,
                noShow: a.noShow,
                confirmed: a.confirmed,
                rates: {
                    completion: Math.round(completionRate * 100) / 100,
                    cancellation: Math.round(cancellationRate * 100) / 100,
                    noShow: Math.round(noShowRate * 100) / 100
                }
            },
            sessions: {
                total: s.totalSessions,
                completed: s.completedSessions,
                revenue: s.totalRevenue,
                commission: s.totalCommission,
                netRevenue: s.totalRevenue - s.totalCommission
            },
            packages: {
                sold: p.packagesSold,
                totalValue: p.totalValue,
                totalPaid: p.totalPaid,
                totalSessions: p.totalSessions,
                avgPackageValue: p.packagesSold > 0 ? p.totalValue / p.packagesSold : 0
            },
            productionByDoctor
        };

        res.json({
            success: true,
            data: overview
        });

    } catch (error) {
        console.error('[OperationalAnalytics] Erro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar analytics operacional',
            message: error.message
        });
    }
});

export default router;
