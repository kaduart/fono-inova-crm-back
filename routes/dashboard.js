/**
 * 🚀 Dashboard Stats API - Endpoint Consolidado
 * 
 * Combina múltiplas estatísticas em uma única chamada,
 * reduzindo o número de requisições do frontend de 5+ para 1.
 * 
 * Rotas:
 * - GET /api/dashboard/stats - Estatísticas gerais
 * - GET /api/dashboard/charts - Dados para gráficos
 * - GET /api/dashboard/overview - Visão completa (stats + charts)
 */

import express from 'express';
import moment from 'moment-timezone';
import mongoose from 'mongoose';
import { auth, authorize } from '../middleware/auth.js';
import { cacheFunction, DEFAULT_TTL, invalidateCache } from '../middleware/cache.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import Lead from '../models/Leads.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';

const router = express.Router();

// Timezone padrão
const TIMEZONE = 'America/Sao_Paulo';

/**
 * 🔢 Calcula estatísticas gerais do dashboard
 * Cache: 3 minutos
 */
async function calculateStats() {
    const today = moment().tz(TIMEZONE).startOf('day');
    const todayEnd = moment().tz(TIMEZONE).endOf('day');
    const startOfMonth = moment().tz(TIMEZONE).startOf('month');
    const startOfWeek = moment().tz(TIMEZONE).startOf('week');

    // Executar queries em paralelo para máxima performance
    const [
        totalPatients,
        totalDoctors,
        todayAppointments,
        weekAppointments,
        pendingPayments,
        monthRevenue,
        monthLeads,
        leadsByStatus
    ] = await Promise.all([
        // Total de pacientes
        Patient.countDocuments(),

        // Total de profissionais
        Doctor.countDocuments(),

        // Agendamentos de hoje
        Appointment.countDocuments({
            date: {
                $gte: today.format('YYYY-MM-DD'),
                $lte: todayEnd.format('YYYY-MM-DD')
            },
            operationalStatus: { $nin: ['canceled'] }
        }),

        // Agendamentos da semana
        Appointment.countDocuments({
            date: {
                $gte: startOfWeek.format('YYYY-MM-DD'),
                $lte: todayEnd.format('YYYY-MM-DD')
            },
            operationalStatus: { $nin: ['canceled'] }
        }),

        // Pagamentos pendentes
        Payment.countDocuments({
            status: { $in: ['pending', 'partial'] }
        }),

        // Receita do mês (apenas pagamentos confirmados)
        Payment.aggregate([
            {
                $match: {
                    status: 'paid',
                    paymentDate: {
                        $gte: startOfMonth.toDate()
                    }
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: '$amount' }
                }
            }
        ]),

        // Leads do mês
        Lead.countDocuments({
            createdAt: { $gte: startOfMonth.toDate() }
        }),

        // Leads por status (para badge de contagem)
        Lead.aggregate([
            {
                $match: {
                    createdAt: { $gte: startOfMonth.toDate() }
                }
            },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ])
    ]);

    // Formatar leads por status
    const leadsStatusMap = leadsByStatus.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
    }, {});

    return {
        totalPatients,
        totalDoctors,
        todayAppointments,
        weekAppointments,
        pendingPayments,
        monthRevenue: monthRevenue[0]?.total || 0,
        monthLeads,
        leadsByStatus: leadsStatusMap,
        calculatedAt: new Date().toISOString()
    };
}

/**
 * 📊 Calcula dados para gráficos
 * Cache: 5 minutos
 */
async function calculateChartData() {
    const today = moment().tz(TIMEZONE);
    const last7Days = today.clone().subtract(6, 'days');
    const last30Days = today.clone().subtract(29, 'days');

    // Datas para consulta
    const dates7Days = Array.from({ length: 7 }, (_, i) =>
        last7Days.clone().add(i, 'days').format('YYYY-MM-DD')
    );

    // Agendamentos por dia (últimos 7 dias)
    const appointmentsByDay = await Appointment.aggregate([
        {
            $match: {
                date: { $gte: last7Days.format('YYYY-MM-DD') },
                operationalStatus: { $nin: ['canceled'] }
            }
        },
        {
            $group: {
                _id: '$date',
                count: { $sum: 1 }
            }
        },
        { $sort: { _id: 1 } }
    ]);

    // Preencher dias sem dados
    const appointmentsMap = appointmentsByDay.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
    }, {});

    const appointmentsChart = dates7Days.map(date => ({
        date: moment(date).format('DD/MM'),
        count: appointmentsMap[date] || 0
    }));

    // Leads por origem (mês atual)
    const leadsByOrigin = await Lead.aggregate([
        {
            $match: {
                createdAt: { $gte: last30Days.toDate() }
            }
        },
        {
            $group: {
                _id: '$origin',
                count: { $sum: 1 }
            }
        },
        { $sort: { count: -1 } },
        { $limit: 6 }
    ]);

    // Receita por dia (últimos 7 dias)
    const revenueByDay = await Payment.aggregate([
        {
            $match: {
                status: 'paid',
                paymentDate: { $gte: last7Days.toDate() }
            }
        },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate' } },
                total: { $sum: '$amount' }
            }
        },
        { $sort: { _id: 1 } }
    ]);

    const revenueMap = revenueByDay.reduce((acc, item) => {
        acc[item._id] = item.total;
        return acc;
    }, {});

    const revenueChart = dates7Days.map(date => ({
        date: moment(date).format('DD/MM'),
        value: revenueMap[date] || 0
    }));

    // Pacientes por especialidade (top 5)
    const patientsBySpecialty = await Appointment.aggregate([
        {
            $match: {
                date: { $gte: last30Days.format('YYYY-MM-DD') },
                operationalStatus: { $nin: ['canceled'] }
            }
        },
        {
            $group: {
                _id: '$specialty',
                count: { $sum: 1 }
            }
        },
        { $sort: { count: -1 } },
        { $limit: 5 }
    ]);

    return {
        appointmentsChart,
        leadsByOrigin,
        revenueChart,
        patientsBySpecialty,
        calculatedAt: new Date().toISOString()
    };
}

/**
 * 👥 Lista resumida de profissionais com métricas - OTIMIZADO
 * Reduz de 20+ queries para apenas 3 queries!
 */
async function getDoctorsOverview() {
    const last30Days = moment().tz(TIMEZONE).subtract(30, 'days').format('YYYY-MM-DD');

    // 🚀 Busca todos os médicos (1 query)
    const doctors = await Doctor.find()
        .select('fullName specialty')
        .sort({ fullName: 1 })
        .lean();

    const doctorIds = doctors.map(d => d._id.toString());

    // 🚀 Contagem de pacientes por médico em PARALELO (2 queries agregadas)
    const [patientCounts, appointmentCounts] = await Promise.all([
        // Conta pacientes por doctor (1 query só!)
        Patient.aggregate([
            {
                $match: {
                    doctor: { $in: doctorIds.map(id => new mongoose.Types.ObjectId(id)) }
                }
            },
            {
                $group: {
                    _id: '$doctor',
                    count: { $sum: 1 }
                }
            }
        ]),

        // Conta agendamentos por doctor nos últimos 30 dias (1 query só!)
        Appointment.aggregate([
            {
                $match: {
                    doctor: { $in: doctorIds.map(id => new mongoose.Types.ObjectId(id)) },
                    date: { $gte: last30Days }
                }
            },
            {
                $group: {
                    _id: '$doctor',
                    count: { $sum: 1 }
                }
            }
        ])
    ]);

    // Converte arrays de agregação para mapas (O(1) lookup)
    const patientMap = patientCounts.reduce((acc, item) => {
        acc[item._id.toString()] = item.count;
        return acc;
    }, {});

    const appointmentMap = appointmentCounts.reduce((acc, item) => {
        acc[item._id.toString()] = item.count;
        return acc;
    }, {});

    // Monta resultado final
    return doctors.slice(0, 10).map(doctor => ({
        _id: doctor._id,
        name: doctor.fullName,
        specialty: doctor.specialty,
        patients: patientMap[doctor._id.toString()] || 0,
        appointments: appointmentMap[doctor._id.toString()] || 0
    }));
}

/**
 * 📅 Próximas consultas (para exibição no dashboard)
 */
async function getUpcomingAppointments() {
    const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
    const nextWeek = moment().tz(TIMEZONE).add(7, 'days').format('YYYY-MM-DD');

    const appointments = await Appointment.find({
        date: { $gte: today, $lte: nextWeek },
        operationalStatus: { $nin: ['canceled', 'completed'] }
    })
        .select('date time reason operationalStatus patient doctor')
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName')
        .sort({ date: 1, time: 1 })
        .limit(10)
        .lean();

    return appointments.map(appt => ({
        _id: appt._id,
        date: appt.date,
        time: appt.time,
        reason: appt.reason,
        status: appt.operationalStatus,
        patient: appt.patient?.fullName || 'Paciente não encontrado',
        doctor: appt.doctor?.fullName || 'Profissional não encontrado'
    }));
}

// ============================================
// 🔒 ROTAS PROTEGIDAS
// ============================================
router.use(auth);

/**
 * GET /api/dashboard/stats
 * Estatísticas gerais do dashboard
 */
router.get('/stats', authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const cacheKey = `dashboard:stats:${moment().tz(TIMEZONE).format('YYYY-MM-DD:HH')}`;
        
        const stats = await cacheFunction(
            calculateStats,
            cacheKey,
            DEFAULT_TTL.STATS
        );

        res.json({
            success: true,
            data: stats,
            cached: true
        });
    } catch (error) {
        console.error('Erro ao calcular stats:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao calcular estatísticas'
        });
    }
});

/**
 * GET /api/dashboard/charts
 * Dados para gráficos
 */
router.get('/charts', authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const cacheKey = `dashboard:charts:${moment().tz(TIMEZONE).format('YYYY-MM-DD:HH')}`;
        
        const charts = await cacheFunction(
            calculateChartData,
            cacheKey,
            DEFAULT_TTL.STATS * 2 // Cache mais longo para charts
        );

        res.json({
            success: true,
            data: charts,
            cached: true
        });
    } catch (error) {
        console.error('Erro ao calcular charts:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao calcular dados dos gráficos'
        });
    }
});

/**
 * GET /api/dashboard/overview
 * Visão completa (stats + charts + overview)
 * Endpoint principal para carregamento inicial do dashboard
 */
router.get('/overview', authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const cacheKey = `dashboard:overview:${moment().tz(TIMEZONE).format('YYYY-MM-DD:HH:mm')}`;
        
        const overview = await cacheFunction(async () => {
            const [stats, charts, doctorsOverview, upcomingAppointments] = await Promise.all([
                calculateStats(),
                calculateChartData(),
                getDoctorsOverview(),
                getUpcomingAppointments()
            ]);

            return {
                stats,
                charts,
                doctorsOverview,
                upcomingAppointments,
                generatedAt: new Date().toISOString()
            };
        }, cacheKey, DEFAULT_TTL.STATS);

        res.json({
            success: true,
            data: overview,
            cached: true
        });
    } catch (error) {
        console.error('Erro ao calcular overview:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao calcular visão geral'
        });
    }
});

/**
 * GET /api/dashboard/doctors-overview
 * Visão geral dos profissionais
 */
router.get('/doctors-overview', authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const cacheKey = `dashboard:doctors:${moment().tz(TIMEZONE).format('YYYY-MM-DD')}`;
        
        const doctors = await cacheFunction(
            getDoctorsOverview,
            cacheKey,
            DEFAULT_TTL.LIST
        );

        res.json({
            success: true,
            data: doctors
        });
    } catch (error) {
        console.error('Erro ao buscar doctors overview:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar visão dos profissionais'
        });
    }
});

/**
 * GET /api/dashboard/upcoming
 * Próximas consultas
 */
router.get('/upcoming', authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const cacheKey = `dashboard:upcoming:${limit}:${moment().tz(TIMEZONE).format('YYYY-MM-DD:HH')}`;
        
        const appointments = await cacheFunction(
            getUpcomingAppointments,
            cacheKey,
            DEFAULT_TTL.LIST
        );

        res.json({
            success: true,
            data: appointments
        });
    } catch (error) {
        console.error('Erro ao buscar upcoming:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar próximas consultas'
        });
    }
});

/**
 * POST /api/dashboard/invalidate-cache
 * Invalidar cache do dashboard (útil após operações de escrita)
 */
router.post('/invalidate-cache', authorize(['admin']), async (req, res) => {
    try {
        await invalidateCache('dashboard:*');
        res.json({
            success: true,
            message: 'Cache do dashboard invalidado'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
