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
            availableSlots: 180,
            expectedRevenue: 32000   // R$ 32k esperado
        },
        createdBy: userId
    });
};