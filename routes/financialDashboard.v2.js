// routes/financialDashboard.v2.js
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import Payment from '../models/Payment.js';
import Expense from '../models/Expense.js';
import Appointment from '../models/Appointment.js';

const router = express.Router();

// GET /v2/financial/dashboard - Dashboard completo
router.get('/', auth, async (req, res) => {
    try {
        const { month, year, view = 'monthly' } = req.query;
        const targetMonth = month ? parseInt(month) : moment().month();
        const targetYear = year ? parseInt(year) : moment().year();
        
        const startOfMonth = moment.tz([targetYear, targetMonth], "America/Sao_Paulo").startOf('month').toDate();
        const endOfMonth = moment.tz([targetYear, targetMonth], "America/Sao_Paulo").endOf('month').toDate();
        
        // Busca dados em paralelo
        const [payments, expenses, appointments] = await Promise.all([
            Payment.find({
                paymentDate: { $gte: startOfMonth, $lte: endOfMonth },
                status: 'paid'
            }).lean(),
            Expense.find({
                date: { $gte: startOfMonth, $lte: endOfMonth }
            }).lean(),
            Appointment.find({
                date: {
                    $gte: startOfMonth.toISOString().split('T')[0],
                    $lte: endOfMonth.toISOString().split('T')[0]
                }
            }).lean()
        ]);
        
        // Calcula métricas
        const totalRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
        const totalAppointments = appointments.length;
        const completedAppointments = appointments.filter(a => a.status === 'completed').length;
        
        res.json({
            success: true,
            data: {
                period: { month: targetMonth, year: targetYear },
                revenue: {
                    total: totalRevenue,
                    byMethod: payments.reduce((acc, p) => {
                        acc[p.paymentMethod] = (acc[p.paymentMethod] || 0) + p.amount;
                        return acc;
                    }, {})
                },
                expenses: {
                    total: totalExpenses,
                    count: expenses.length
                },
                balance: totalRevenue - totalExpenses,
                appointments: {
                    total: totalAppointments,
                    completed: completedAppointments,
                    completionRate: totalAppointments > 0 ? (completedAppointments / totalAppointments * 100).toFixed(1) : 0
                }
            }
        });
    } catch (error) {
        console.error('[FinancialDashboardV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /v2/financial/dashboard/projection-daily - Projeção diária
router.get('/projection-daily', auth, async (req, res) => {
    try {
        const { month } = req.query;
        const targetMonth = month ? parseInt(month) : moment().month();
        const year = moment().year();
        
        const daysInMonth = moment([year, targetMonth]).daysInMonth();
        const projections = [];
        
        for (let day = 1; day <= daysInMonth; day++) {
            const date = moment([year, targetMonth, day]).format('YYYY-MM-DD');
            projections.push({
                date,
                projected: 0,
                actual: 0
            });
        }
        
        res.json({
            success: true,
            data: projections
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
