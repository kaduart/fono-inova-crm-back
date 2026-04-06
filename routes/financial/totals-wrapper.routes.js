// Wrapper que usa cashflow (funciona) em vez de totals (quebrado)
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../../middleware/auth.js';
import Payment from '../../models/Payment.js';
import Expense from '../../models/Expense.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

// GET /api/v2/totals-usa-cashflow
router.get('/totals-usa-cashflow', auth, async (req, res) => {
    try {
        const { date, period = 'month' } = req.query;
        const targetDate = date 
            ? moment.tz(date, "America/Sao_Paulo") 
            : moment.tz(TIMEZONE);
        
        // Define período igual ao cashflow
        const start = targetDate.clone().startOf(period);
        const end = targetDate.clone().endOf(period);
        
        // MATCH IGUAL AO CASHFLOW (que funciona!)
        const matchStage = {
            status: { $in: ['paid', 'completed', 'confirmed'] },
            $or: [
                {
                    paymentDate: {
                        $gte: start.format('YYYY-MM-DD'),
                        $lte: end.format('YYYY-MM-DD')
                    }
                },
                {
                    createdAt: { $gte: start.toDate(), $lte: end.toDate() }
                }
            ]
        };
        
        // Busca igual ao cashflow
        const payments = await Payment.find(matchStage).lean();
        
        let totalReceived = 0;
        let totalPending = 0;
        let particularReceived = 0;
        let insuranceReceived = 0;
        let countReceived = 0;
        let countPending = 0;
        
        payments.forEach(p => {
            const amount = p.amount || 0;
            
            if (p.status === 'paid' || p.status === 'completed' || p.status === 'confirmed') {
                totalReceived += amount;
                countReceived++;
                
                // Separa particular de convênio
                if (p.billingType === 'convenio' || p.insurance?.status) {
                    insuranceReceived += amount;
                } else {
                    particularReceived += amount;
                }
            } else if (p.status === 'pending') {
                totalPending += amount;
                countPending++;
            }
        });
        
        // Busca despesas
        const expenses = await Expense.aggregate([
            { $match: {
                status: 'paid',
                date: { 
                    $gte: start.format('YYYY-MM-DD'),
                    $lte: end.format('YYYY-MM-DD')
                }
            }},
            { $group: {
                _id: null,
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }}
        ]);
        
        const totalExpenses = expenses[0]?.total || 0;
        const profit = totalReceived - totalExpenses;
        
        res.json({
            success: true,
            data: {
                totals: {
                    totalReceived,
                    totalProduction: totalReceived,
                    totalPending,
                    countReceived,
                    countPending,
                    particularReceived,
                    insurance: {
                        pendingBilling: 0,
                        billed: 0,
                        received: insuranceReceived
                    },
                    expenses: {
                        total: totalExpenses,
                        pending: 0,
                        count: expenses[0]?.count || 0
                    },
                    profit,
                    profitMargin: totalReceived > 0 ? Math.round((profit / totalReceived) * 100 * 100) / 100 : 0,
                    packageCredit: {
                        contractedRevenue: 0,
                        cashReceived: 0,
                        deferredRevenue: 0,
                        deferredSessions: 0,
                        recognizedRevenue: 0,
                        recognizedSessions: 0,
                        totalSessions: 0,
                        activePackages: 0
                    },
                    patientBalance: {
                        totalDebt: 0,
                        totalCredit: 0,
                        totalDebited: 0,
                        totalCredited: 0,
                        patientsWithDebt: 0,
                        patientsWithCredit: 0
                    }
                },
                period,
                date: targetDate.format('YYYY-MM-DD'),
                source: 'cashflow_based'
            }
        });
        
    } catch (error) {
        console.error('[TotalsWrapper] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
