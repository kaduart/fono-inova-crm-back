// services/planningService.js
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Planning from '../models/Planning.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';

/**
 * Atualiza automaticamente o progresso do planejamento
 * baseado nos dados reais de sessões e pagamentos
 */
export const updatePlanningProgress = async (planningId) => {
    try {
        const planning = await Planning.findById(planningId);
        if (!planning) throw new Error('Planejamento não encontrado');

        const { start, end } = planning.period;

        console.log(`[Planning Update] 📊 Atualizando planejamento ${planningId}`);
        console.log(`[Planning Update] 📅 Período: ${start} a ${end}`);

        // 1. Buscar sessões concluídas no período
        const sessions = await Session.find({
            date: { $gte: start, $lte: end },
            status: 'completed'
        }).lean();

        // 2. Buscar pagamentos recebidos no período
        const payments = await Payment.find({
            paymentDate: { $gte: start, $lte: end },
            status: 'paid'
        }).lean();

        // 3. Buscar agendamentos completados (para horas trabalhadas mais precisas)
        const appointments = await Appointment.find({
            date: { $gte: start, $lte: end },
            clinicalStatus: 'completed'
        }).lean();

        // Calcular totais
        const completedSessions = sessions.length;
        const actualRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        
        // Calcular horas trabalhadas (baseado na duração dos agendamentos ou 40min padrão)
        const workedHours = appointments.length > 0 
            ? appointments.reduce((sum, apt) => sum + ((apt.duration || 40) / 60), 0)
            : completedSessions * 0.67; // 40min = 0.67h

        // Atualizar dados reais
        planning.actual.completedSessions = completedSessions;
        planning.actual.workedHours = parseFloat(workedHours.toFixed(2));
        planning.actual.usedSlots = completedSessions;
        planning.actual.actualRevenue = actualRevenue;

        console.log(`[Planning Update] ✅ Dados atualizados:`);
        console.log(`[Planning Update]    - Sessões: ${completedSessions}`);
        console.log(`[Planning Update]    - Receita: R$ ${actualRevenue}`);
        console.log(`[Planning Update]    - Horas: ${workedHours.toFixed(2)}h`);

        await planning.save(); // Middleware calcula progresso automaticamente

        return planning;

    } catch (error) {
        console.error('[Planning Update] ❌ Erro ao atualizar progresso:', error);
        throw error;
    }
};

/**
 * Atualiza o progresso de TODOS os planejamentos ativos
 * Útil para rodar em cron jobs
 */
export const updateAllPlanningsProgress = async () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Buscar planejamentos que ainda estão em andamento
        const plannings = await Planning.find({
            'period.end': { $gte: today }
        });

        console.log(`[Planning Update] 🔄 Atualizando ${plannings.length} planejamentos...`);

        const results = [];
        for (const planning of plannings) {
            try {
                const updated = await updatePlanningProgress(planning._id);
                results.push({
                    id: planning._id,
                    status: 'success',
                    progress: updated.progress
                });
            } catch (err) {
                results.push({
                    id: planning._id,
                    status: 'error',
                    error: err.message
                });
            }
        }

        return {
            success: true,
            updated: results.filter(r => r.status === 'success').length,
            failed: results.filter(r => r.status === 'error').length,
            results
        };

    } catch (error) {
        console.error('[Planning Update] ❌ Erro ao atualizar todos os planejamentos:', error);
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

/**
 * Calcula o progresso detalhado com informações extras
 * Retorna dados enriquecidos para o dashboard
 */
export const calculateDetailedProgress = async (planningId) => {
    try {
        const planning = await Planning.findById(planningId);
        if (!planning) throw new Error('Planejamento não encontrado');

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
            date: {
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
            valorPago: pkg.totalPaid,
            status: pkg.financialStatus,
            criadoEm: pkg.date
        }));

        // 3. Calcular totais gerais
        const totalRevenue = pagamentos.reduce((sum, p) => sum + (p.amount || 0), 0);
        const totalSessions = await Session.countDocuments({
            date: { $gte: start, $lte: end },
            status: 'completed'
        });

        // 4. Calcular gap (quanto falta)
        const gapRevenue = Math.max(0, planning.targets.expectedRevenue - totalRevenue);
        const gapSessions = Math.max(0, planning.targets.totalSessions - totalSessions);

        // 5. Calcular dias restantes
        const today = new Date();
        const endDate = new Date(end);
        const daysRemaining = Math.max(0, Math.ceil((endDate - today) / (1000 * 60 * 60 * 24)));

        // 6. Calcular meta diária necessária
        const dailyRevenueNeeded = daysRemaining > 0 ? gapRevenue / daysRemaining : 0;
        const dailySessionsNeeded = daysRemaining > 0 ? gapSessions / daysRemaining : 0;

        return {
            actual: {
                actualRevenue: totalRevenue,
                completedSessions: totalSessions,
                workedHours: totalSessions * 0.67
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
                gapRevenue: gapRevenue,
                gapSessions: gapSessions,
                overallStatus: totalRevenue >= planning.targets.expectedRevenue ? 'achieved' :
                    totalRevenue >= planning.targets.expectedRevenue * 0.8 ? 'on_track' :
                        totalRevenue >= planning.targets.expectedRevenue * 0.5 ? 'at_risk' : 'behind'
            },
            projections: {
                daysRemaining,
                dailyRevenueNeeded: Math.round(dailyRevenueNeeded),
                dailySessionsNeeded: Math.ceil(dailySessionsNeeded)
            }
        };

    } catch (error) {
        console.error('[Planning Service] ❌ Erro ao calcular progresso detalhado:', error);
        throw error;
    }
};

export default {
    updatePlanningProgress,
    updateAllPlanningsProgress,
    createWeeklyPlanning,
    createMonthlyPlanning,
    calculateDetailedProgress
};
