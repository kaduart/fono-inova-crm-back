import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import moment from 'moment-timezone';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';
import { eventExists } from '../infrastructure/events/eventStoreService.js';
import TotalsSnapshot from '../models/TotalsSnapshot.js';
import Payment from '../models/Payment.js';
import Expense from '../models/Expense.js';
import PackagesView from '../models/PackagesView.js';
import PatientBalance from '../models/PatientBalance.js';

const TIMEZONE = 'America/Sao_Paulo';

function getDateRange(period, targetDate) {
    const now = moment.tz(targetDate, TIMEZONE);
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
    return { startStr, endStr, dateStr: now.format('YYYY-MM-DD') };
}

export function startTotalsWorker() {
    console.log('[TotalsWorker] Criando worker...');

    const worker = new Worker('totals-calculation', async (job) => {
        const { eventId, payload } = job.data;
        const { clinicId, date, period = 'month', correlationId } = payload;
        
        const log = createContextLogger(correlationId || eventId, 'totalsWorker');
        const { startStr, endStr, dateStr } = getDateRange(period, date);
        
        log.info('calculation_started', `Calculando totais: ${dateStr}`, { period, startStr, endStr });

        // Idempotência
        const idempotencyKey = `totals_${clinicId || 'default'}_${dateStr}_${period}`;
        if (await eventExists(idempotencyKey)) {
            log.info('already_processed', 'Totais já calculados');
            return { status: 'already_processed' };
        }

        const rangeStart = new Date(startStr);
        const rangeEnd = new Date(endStr);

        // MATCH: Date direto no paymentDate
        const matchStage = {
            status: { $ne: 'canceled' },
            kind: { $ne: 'package_consumed' }, // 🛡️ package_consumed NÃO é caixa
            paymentDate: { $gte: rangeStart, $lte: rangeEnd }
        };
        if (clinicId) matchStage.clinicId = clinicId;

        const [paymentResult, expenseResult, packageResult, balanceResult] = await Promise.all([
            Payment.aggregate([
                { $match: matchStage },
                { $group: {
                    _id: null,
                    totalReceived: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
                    totalProduction: { $sum: '$amount' },
                    totalPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } },
                    countReceived: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                    countPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
                    particularReceived: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'paid'] }, { $ne: ['$billingType', 'convenio'] }] }, '$amount', 0] } }
                }}
            ]),
            Expense.aggregate([
                { $match: { status: { $ne: 'canceled' }, date: { $gte: startStr.split('T')[0], $lte: endStr.split('T')[0] } } },
                { $group: { _id: null, totalExpenses: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }, totalExpensesPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } }, countExpenses: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } } } }
            ]),
            PackagesView.aggregate([{ $match: { status: { $in: ['active', 'finished'] } } }, { $group: { _id: null, contractedRevenue: { $sum: '$totalValue' }, cashReceived: { $sum: '$totalPaid' }, deferredRevenue: { $sum: { $multiply: ['$sessionsRemaining', '$sessionValue'] } }, deferredSessions: { $sum: '$sessionsRemaining' }, recognizedRevenue: { $sum: { $multiply: ['$sessionsUsed', '$sessionValue'] } }, recognizedSessions: { $sum: '$sessionsUsed' }, totalSessions: { $sum: '$totalSessions' }, activePackages: { $sum: 1 } } }]),
            PatientBalance.aggregate([{ $group: { _id: null, totalDebt: { $sum: { $cond: [{ $gt: ['$currentBalance', 0] }, '$currentBalance', 0] } }, totalCredit: { $sum: { $cond: [{ $lt: ['$currentBalance', 0] }, { $multiply: ['$currentBalance', -1] }, 0] } }, totalDebited: { $sum: '$totalDebited' }, totalCredited: { $sum: '$totalCredited' }, patientsWithDebt: { $sum: { $cond: [{ $gt: ['$currentBalance', 0] }, 1, 0] } }, patientsWithCredit: { $sum: { $cond: [{ $lt: ['$currentBalance', 0] }, 1, 0] } } } }])
        ]);

        const p = paymentResult[0] || {};
        const exp = expenseResult[0] || {};
        const pkg = packageResult[0] || {};
        const bal = balanceResult[0] || {};
        
        const totalReceived = p.totalReceived || 0;
        const totalExpenses = exp.totalExpenses || 0;
        const profit = totalReceived - totalExpenses;

        const totals = {
            totalReceived,
            totalProduction: p.totalProduction || 0,
            totalPending: p.totalPending || 0,
            countReceived: p.countReceived || 0,
            countPending: p.countPending || 0,
            particularReceived: p.particularReceived || 0,
            insurance: { pendingBilling: 0, billed: 0, received: 0 },
            packageCredit: { contractedRevenue: pkg.contractedRevenue || 0, cashReceived: pkg.cashReceived || 0, deferredRevenue: Math.max(0, pkg.deferredRevenue || 0), deferredSessions: Math.max(0, pkg.deferredSessions || 0), recognizedRevenue: pkg.recognizedRevenue || 0, recognizedSessions: pkg.recognizedSessions || 0, totalSessions: pkg.totalSessions || 0, activePackages: pkg.activePackages || 0 },
            patientBalance: { totalDebt: bal.totalDebt || 0, totalCredit: bal.totalCredit || 0, totalDebited: bal.totalDebited || 0, totalCredited: bal.totalCredited || 0, patientsWithDebt: bal.patientsWithDebt || 0, patientsWithCredit: bal.patientsWithCredit || 0 },
            expenses: { total: totalExpenses, pending: exp.totalExpensesPending || 0, count: exp.countExpenses || 0 },
            profit,
            profitMargin: totalReceived > 0 ? Math.round((profit / totalReceived) * 100 * 100) / 100 : 0
        };

        await TotalsSnapshot.findOneAndUpdate(
            { clinicId: clinicId || 'default', date: dateStr, period },
            { totals, calculatedAt: new Date(), period, correlationId },
            { upsert: true, new: true }
        );

        log.info('calculation_completed', `Totais: R$ ${totalReceived.toFixed(2)}`, { totalReceived, totalExpenses, profit });

        await publishEvent(EventTypes.TOTALS_RECALCULATED, { clinicId: clinicId || 'default', date: dateStr, period, totals, correlationId });

        return { status: 'completed', totals };

    }, {
        connection: redisConnection,
        concurrency: 2,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    });

    worker.on('completed', (job) => {
        console.log(`[TotalsWorker] ✅ Job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[TotalsWorker] ❌ Job ${job?.id} failed:`, err.message);
    });

    console.log('[TotalsWorker] ✅ Worker iniciado');
    return worker;
}

export default { startTotalsWorker };
