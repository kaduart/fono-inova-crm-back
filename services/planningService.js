// services/planningService.js
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Planning from '../models/Planning.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

/**
 * Atualiza automaticamente o progresso do planejamento
 * baseado nos dados reais de sessões e pagamentos
 */
export const updatePlanningProgress = async (planningId) => {
    try {
        const planning = await Planning.findById(planningId);
        if (!planning) throw new Error('Planejamento não encontrado');

        const { start, end } = planning.period;

        // Buscar sessões concluídas no período
        const sessions = await Session.find({
            date: { $gte: start, $lte: end },
            status: 'completed'
        }).lean();

        // Buscar pagamentos recebidos no período
        const payments = await Payment.find({
            paymentDate: { $gte: start, $lte: end },
            status: 'paid'
        }).lean();

        // Atualizar dados reais
        planning.actual.completedSessions = sessions.length;
        planning.actual.workedHours = sessions.length * 0.67; // 40min = 0.67h
        planning.actual.usedSlots = sessions.length;
        planning.actual.actualRevenue = payments.reduce((sum, p) => sum + p.amount, 0);

        await planning.save(); // Middleware calcula progresso automaticamente

        return planning;

    } catch (error) {
        console.error('Erro ao atualizar progresso:', error);
        throw error;
    }
};

/**
 * Cria planejamento semanal automático
 */
export const createWeeklyPlanning = async (startDate, userId) => {
    const endDate = moment(startDate).add(6, 'days').format('YYYY-MM-DD');

    return await Planning.create({
        type: 'weekly',
        period: { start: startDate, end: endDate },
        targets: {
            totalSessions: 40,      // exemplo: 40 sessões/semana
            workHours: 26.8,        // 40 sessões * 40min
            availableSlots: 50,     // 50 vagas disponíveis
            expectedRevenue: 8000   // R$ 8k esperado
        },
        createdBy: userId
    });
};

/**
 * Cria planejamento mensal automático
 */
export const createMonthlyPlanning = async (month, year, userId) => {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    return await Planning.create({
        type: 'monthly',
        period: { start: startDate, end: endDate },
        targets: {
            totalSessions: 160,      // exemplo: 160 sessões/mês
            workHours: 107,          // 160 * 40min
            availableSlots: 160,
            expectedRevenue: 32000   // R$ 32k esperado
        },
        createdBy: userId
    });
};

// Adicione esta função ao planningService.js ou dentro da rota de update-progress

const calculateDetailedProgress = async (planning) => {
    const { start, end } = planning.period;

    // 1. Buscar pagamentos do período com detalhes do paciente
    const pagamentos = await Payment.find({
        paymentDate: { $gte: start, $lte: end },
        status: 'paid'
    })
        .populate('patient', 'fullName phoneNumber')
        .populate('doctor', 'fullName specialty')
        .sort({ paymentDate: -1 })
        .lean();

    // Agrupar por paciente
    const porPaciente = {};
    pagamentos.forEach(pag => {
        const pacienteId = pag.patient?._id?.toString() || 'sem-paciente';
        if (!porPaciente[pacienteId]) {
            porPaciente[pacienteId] = {
                paciente: pag.patient?.fullName || 'N/A',
                telefone: pag.patient?.phoneNumber,
                totalPago: 0,
                pagamentos: []
            };
        }
        porPaciente[pacienteId].totalPago += pag.amount || 0;
        porPaciente[pacienteId].pagamentos.push({
            data: pag.paymentDate,
            valor: pag.amount,
            forma: pag.paymentMethod,
            profissional: pag.doctor?.fullName
        });
    });

    // 2. Buscar pacotes fechados no período
    const pacotes = await Package.find({
        createdAt: {
            $gte: new Date(start + 'T00:00:00.000Z'),
            $lte: new Date(end + 'T23:59:59.999Z')
        }
    })
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName specialty')
        .lean();

    const pacotesDetalhados = pacotes.map(pkg => ({
        paciente: pkg.patient?.fullName || 'N/A',
        profissional: pkg.doctor?.fullName || 'N/A',
        especialidade: pkg.doctor?.specialty,
        sessoes: pkg.totalSessions,
        valorTotal: pkg.totalValue,
        valorPago: pkg.paidValue,
        status: pkg.financialStatus,
        criadoEm: pkg.createdAt
    }));

    // 3. Calcular totais gerais (já existente)
    const totalRevenue = pagamentos.reduce((sum, p) => sum + (p.amount || 0), 0);
    const totalSessions = await Appointment.countDocuments({
        date: { $gte: start, $lte: end },
        clinicalStatus: 'completed'
    });

    return {
        actual: {
            actualRevenue: totalRevenue,
            completedSessions: totalSessions,
            workedHours: totalSessions * 1 // ou calcular baseado no tempo real
        },
        details: {
            porPaciente: Object.values(porPaciente),
            pacotesFechados: pacotesDetalhados,
            totalPacientes: Object.keys(porPaciente).length,
            totalPacotes: pacotes.length
        },
        progress: {
            sessionsPercentage: Math.round((totalSessions / planning.targets.totalSessions) * 100),
            revenuePercentage: Math.round((totalRevenue / planning.targets.expectedRevenue) * 100),
            gapRevenue: Math.max(0, planning.targets.expectedRevenue - totalRevenue),
            overallStatus: totalRevenue >= planning.targets.expectedRevenue ? 'achieved' :
                totalRevenue >= planning.targets.expectedRevenue * 0.8 ? 'on_track' :
                    totalRevenue >= planning.targets.expectedRevenue * 0.5 ? 'at_risk' : 'behind'
        }
    };
};