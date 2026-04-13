import express from 'express';
import moment from 'moment-timezone';
import TotalsSnapshot from '../../models/TotalsSnapshot.js';
import Payment from '../../models/Payment.js';
import Expense from '../../models/Expense.js';
import PackagesView from '../../models/PackagesView.js';
import PatientBalance from '../../models/PatientBalance.js';
import { createContextLogger } from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

router.get('/overview', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const log = createContextLogger(correlationId, 'financial_overview');

    try {
        const { clinicId, date, period = 'month' } = req.query;
        const targetDate = date ? moment.tz(date, TIMEZONE) : moment.tz(TIMEZONE);
        const dateStr = targetDate.format('YYYY-MM-DD');

        log.info('overview_requested', `Gerando overview: ${dateStr}`, { clinicId, period });

        const now = targetDate.clone();
        const today = moment.tz(TIMEZONE);
        let startStr, endStr;

        switch (period) {
            case 'day':
                startStr = now.clone().startOf('day').format('YYYY-MM-DD') + 'T00:00:00.000Z';
                endStr = now.clone().endOf('day').format('YYYY-MM-DD') + 'T23:59:59.999Z';
                break;
            case 'week':
                startStr = now.clone().startOf('week').format('YYYY-MM-DD') + 'T00:00:00.000Z';
                endStr = now.clone().endOf('week').format('YYYY-MM-DD') + 'T23:59:59.999Z';
                break;
            case 'month':
                startStr = now.clone().startOf('month').format('YYYY-MM-DD') + 'T00:00:00.000Z';
                // Se for o mês atual, vai até hoje
                if (now.format('YYYY-MM') === today.format('YYYY-MM')) {
                    endStr = today.format('YYYY-MM-DD') + 'T23:59:59.999Z';
                } else {
                    endStr = now.clone().endOf('month').format('YYYY-MM-DD') + 'T23:59:59.999Z';
                }
                break;
            default:
                startStr = now.clone().startOf('month').format('YYYY-MM-DD') + 'T00:00:00.000Z';
                endStr = now.clone().endOf('month').format('YYYY-MM-DD') + 'T23:59:59.999Z';
        }

        const rangeStart = new Date(startStr);
        const rangeEnd = new Date(endStr);

        // MATCH: Busca por financialDate (V2) ou paymentDate (legado)
        const matchStage = {
            status: { $ne: 'canceled' },
            $or: [
                { financialDate: { $gte: rangeStart, $lte: rangeEnd } },
                { paymentDate: { $gte: rangeStart, $lte: rangeEnd } }
            ]
        };
        if (clinicId) matchStage.clinicId = clinicId;

        const [paymentResult, methodBreakdown, typeBreakdown, statusCounts, expenseResult, packageResult, balanceResult] = await Promise.all([
            // 1. Totais principais
            Payment.aggregate([
                { $match: matchStage },
                { $group: {
                    _id: null,
                    totalReceived: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
                    totalProduction: { $sum: '$amount' },
                    totalPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } },
                    countReceived: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                    countPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
                    particularReceived: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'paid'] }, { $ne: ['$billingType', 'convenio'] }] }, '$amount', 0] } },
                    insurancePending: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'pending'] }, { $eq: ['$billingType', 'convenio'] }] }, '$amount', 0] } }
                }}
            ]),
            // 2. BREAKDOWN POR MÉTODO
            Payment.aggregate([
                { $match: matchStage },
                { $group: {
                    _id: '$paymentMethod',
                    total: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }
                }}
            ]),
            // 3. BREAKDOWN POR TIPO
            Payment.aggregate([
                { $match: matchStage },
                { $group: {
                    _id: '$source',
                    total: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }
                }}
            ]),
            // 4. CONTAGEM POR STATUS
            Payment.aggregate([
                { $match: matchStage },
                { $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }}
            ]),
            // 5. Despesas
            Expense.aggregate([
                { $match: { status: { $ne: 'canceled' }, date: { $gte: startStr.split('T')[0], $lte: endStr.split('T')[0] } } },
                { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } }, count: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } } } }
            ]),
            // 6. Pacotes
            PackagesView.aggregate([{ $match: { status: { $in: ['active', 'finished'] } } }, { $group: { _id: null, contractedRevenue: { $sum: '$totalValue' }, cashReceived: { $sum: '$totalPaid' }, deferredRevenue: { $sum: { $multiply: ['$sessionsRemaining', '$sessionValue'] } }, deferredSessions: { $sum: '$sessionsRemaining' }, recognizedRevenue: { $sum: { $multiply: ['$sessionsUsed', '$sessionValue'] } }, recognizedSessions: { $sum: '$sessionsUsed' }, totalSessions: { $sum: '$totalSessions' }, activePackages: { $sum: 1 } } }]),
            // 7. Saldos de pacientes
            PatientBalance.aggregate([{ $group: { _id: null, totalDebt: { $sum: { $cond: [{ $gt: ['$currentBalance', 0] }, '$currentBalance', 0] } }, totalCredit: { $sum: { $cond: [{ $lt: ['$currentBalance', 0] }, { $multiply: ['$currentBalance', -1] }, 0] } }, totalDebited: { $sum: '$totalDebited' }, totalCredited: { $sum: '$totalCredited' }, patientsWithDebt: { $sum: { $cond: [{ $gt: ['$currentBalance', 0] }, 1, 0] } }, patientsWithCredit: { $sum: { $cond: [{ $lt: ['$currentBalance', 0] }, 1, 0] } } } }])
        ]);

        const p = paymentResult[0] || {};
        const exp = expenseResult[0] || {};
        const pkg = packageResult[0] || {};
        const bal = balanceResult[0] || {};

        // 🆕 MAPEIA BREAKDOWNS
        const byMethod = {
            pix: 0, card: 0, cash: 0, transfer: 0, insurance: 0, other: 0
        };
        methodBreakdown.forEach(m => {
            const method = (m._id || 'other').toLowerCase();
            if (method.includes('pix')) byMethod.pix = m.total;
            else if (method.includes('cartao') || method.includes('card')) byMethod.card = m.total;
            else if (method.includes('dinheiro') || method.includes('cash')) byMethod.cash = m.total;
            else if (method.includes('transfer')) byMethod.transfer = m.total;
            else if (method.includes('convenio') || method.includes('insurance')) byMethod.insurance = m.total;
            else byMethod.other += m.total;
        });

        const byType = {
            particular: 0, package: 0, insurance: 0, manual: 0
        };
        typeBreakdown.forEach(t => {
            const type = (t._id || 'manual').toLowerCase();
            if (type.includes('appointment') || type.includes('particular')) byType.particular = t.total;
            else if (type.includes('package') || type.includes('pacote')) byType.package = t.total;
            else if (type.includes('convenio') || type.includes('insurance')) byType.insurance = t.total;
            else byType.manual += t.total;
        });

        // 🆕 CONTAGENS POR STATUS
        const countStatus = {
            paid: 0, partial: 0, pending: 0, canceled: 0
        };
        statusCounts.forEach(s => {
            if (s._id) countStatus[s._id] = s.count;
        });

        const totalReceived = p.totalReceived || 0;
        const totalExpenses = exp.total || 0;
        const profit = totalReceived - totalExpenses;

        const overview = {
            // 🆕 FORMATO V2 SIMPLIFICADO (igual ao que você pediu)
            produced: p.totalProduction || 0,
            received: totalReceived,
            pending: (p.totalProduction || 0) - totalReceived,
            
            countPaid: countStatus.paid,
            countPartial: countStatus.partial,
            countPending: countStatus.pending,
            countCanceled: countStatus.canceled,
            totalCount: Object.values(countStatus).reduce((a, b) => a + b, 0),
            
            // 🆕 BREAKDOWNS
            byMethod,
            byType,
            
            // Legado (mantido para compatibilidade)
            revenue: {
                totalReceived,
                totalProduction: p.totalProduction || 0,
                totalPending: p.totalPending || 0,
                particularReceived: p.particularReceived || 0,
                insurance: {
                    pending: p.insurancePending || 0,
                    billed: 0,
                    received: 0
                }
            },
            expenses: {
                total: totalExpenses,
                pending: exp.pending || 0,
                count: exp.count || 0
            },
            profit: {
                value: profit,
                margin: totalReceived > 0 ? Math.round((profit / totalReceived) * 100 * 100) / 100 : 0,
                isPositive: profit >= 0
            },
            packages: {
                contractedRevenue: pkg.contractedRevenue || 0,
                cashReceived: pkg.cashReceived || 0,
                deferredRevenue: Math.max(0, pkg.deferredRevenue || 0),
                deferredSessions: Math.max(0, pkg.deferredSessions || 0),
                recognizedRevenue: pkg.recognizedRevenue || 0,
                recognizedSessions: pkg.recognizedSessions || 0,
                totalSessions: pkg.totalSessions || 0,
                activePackages: pkg.activePackages || 0
            },
            patientBalance: {
                totalDebt: bal.totalDebt || 0,
                totalCredit: bal.totalCredit || 0,
                totalDebited: bal.totalDebited || 0,
                totalCredited: bal.totalCredited || 0,
                patientsWithDebt: bal.patientsWithDebt || 0,
                patientsWithCredit: bal.patientsWithCredit || 0
            }
        };

        log.info('overview_completed', `Overview: Receita R$ ${totalReceived.toFixed(2)}, Despesa R$ ${totalExpenses.toFixed(2)}, Lucro R$ ${profit.toFixed(2)}`);

        res.json({ success: true, data: { overview, period, date: dateStr, calculatedAt: new Date() }, correlationId });

    } catch (error) {
        log.error('overview_error', error.message, { stack: error.stack });
        res.status(500).json({ success: false, error: error.message, correlationId });
    }
});

export default router;
