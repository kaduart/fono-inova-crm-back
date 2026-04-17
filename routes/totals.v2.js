// routes/totals.v2.js
import express from 'express';
import moment from 'moment-timezone';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import TotalsSnapshot from '../models/TotalsSnapshot.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Expense from '../models/Expense.js';
import PackagesView from '../models/PackagesView.js';
import PatientBalance from '../models/PatientBalance.js';
import { createContextLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';
const LOCK_TTL_SECONDS = 30;

// GET /v2/totals
router.get('/', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const log = createContextLogger(correlationId, 'totals_v2');
    
    try {
        const { clinicId, date, period = 'month', month, year } = req.query;
        let targetDate;
        if (month && year) {
            targetDate = moment.tz(`${year}-${String(month).padStart(2, '0')}-15`, TIMEZONE);
        } else {
            targetDate = date ? moment.tz(date, TIMEZONE) : moment.tz(TIMEZONE);
        }
        const dateStr = targetDate.format('YYYY-MM-DD');
        
        log.info('totals_requested', `Buscando totais: ${dateStr}`, { clinicId, period });

        // Busca snapshot
        let snapshot = await TotalsSnapshot.findOne({
            clinicId: clinicId || 'default',
            date: dateStr,
            period
        });

        const STALE_THRESHOLD_MS = 5 * 60 * 1000;
        const isStale = snapshot && (Date.now() - snapshot.calculatedAt.getTime() > STALE_THRESHOLD_MS);
        
        if (snapshot && !isStale) {
            return res.json({
                success: true,
                data: { totals: snapshot.totals, period, date: dateStr, calculatedAt: snapshot.calculatedAt, source: 'snapshot' },
                correlationId
            });
        }

        // CÁLCULO SÍNCRONO COM DATE (CORRETO)
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
                // Se for o mês atual, vai até hoje. Se for mês passado/futuro, vai até o fim
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

        // MATCH: Fonte única de verdade = financialDate (V2)
        const matchStage = {
            status: { $ne: 'canceled' },
            financialDate: { $gte: rangeStart, $lte: rangeEnd }
        };
        if (clinicId) matchStage.clinicId = clinicId;

        const [paymentResult, expenseResult, packageResult, balanceResult, appointments] = await Promise.all([
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
                    particularCountReceived: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'paid'] }, { $ne: ['$billingType', 'convenio'] }] }, 1, 0] } }
                }}
            ]),
            Expense.aggregate([
                { $match: { status: { $ne: 'canceled' }, createdAt: { $gte: rangeStart, $lte: rangeEnd } } },
                { $group: { _id: null, totalExpenses: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }, countExpenses: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } } } }
            ]),
            PackagesView.aggregate([{ $match: { status: { $in: ['active', 'finished'] } } }, { $group: { _id: null, contractedRevenue: { $sum: '$totalValue' }, cashReceived: { $sum: '$totalPaid' }, deferredRevenue: { $sum: { $multiply: ['$sessionsRemaining', '$sessionValue'] } }, deferredSessions: { $sum: '$sessionsRemaining' }, recognizedRevenue: { $sum: { $multiply: ['$sessionsUsed', '$sessionValue'] } }, recognizedSessions: { $sum: '$sessionsUsed' }, totalSessions: { $sum: '$totalSessions' }, activePackages: { $sum: 1 } } }]),
            PatientBalance.aggregate([{ $group: { _id: null, totalDebt: { $sum: { $cond: [{ $gt: ['$currentBalance', 0] }, '$currentBalance', 0] } }, totalCredit: { $sum: { $cond: [{ $lt: ['$currentBalance', 0] }, { $multiply: ['$currentBalance', -1] }, 0] } }, totalDebited: { $sum: '$totalDebited' }, totalCredited: { $sum: '$totalCredited' }, patientsWithDebt: { $sum: { $cond: [{ $gt: ['$currentBalance', 0] }, 1, 0] } }, patientsWithCredit: { $sum: { $cond: [{ $lt: ['$currentBalance', 0] }, 1, 0] } } } }]),
            Appointment.find({
                date: { $gte: rangeStart, $lt: rangeEnd },
                operationalStatus: { $in: ['confirmed', 'completed', 'scheduled'] },
                isDeleted: { $ne: true },
                patient: { $exists: true, $ne: null }
            }).select('_id sessionValue billingType insuranceProvider serviceType paymentStatus').lean()
        ]);

        const p = paymentResult[0] || {};
        const exp = expenseResult[0] || {};
        const pkg = packageResult[0] || {};
        const bal = balanceResult[0] || {};

        // Busca payments vinculados aos appointments para saber o que foi pago
        const appointmentIds = appointments.map(a => a._id.toString());
        const appointmentPayments = await Payment.find({
            appointment: { $in: appointmentIds },
            status: { $in: ['paid', 'completed', 'confirmed'] }
        }).select('appointment').lean();
        const paidAppointmentIds = new Set(appointmentPayments.map(pay => pay.appointment?.toString()));

        // Calcula pendentes baseado em appointments (particular + convenio não pagos)
        let appointmentPendingTotal = 0;
        let appointmentPendingCount = 0;
        let particularPendingTotal = 0;
        let particularPendingCount = 0;
        let totalInsuranceProduction = 0;
        let totalInsurancePending = 0;
        let countInsuranceTotal = 0;
        let countInsurancePending = 0;
        let totalPartial = 0;
        let countPartial = 0;

        for (const a of appointments) {
            const valor = a.sessionValue || 0;
            const isPacote = a.serviceType === 'package_session';
            const isConvenio = a.billingType === 'convenio' || (a.insuranceProvider && a.insuranceProvider.trim() !== '');
            const foiPago = paidAppointmentIds.has(a._id.toString()) || a.paymentStatus === 'package_paid' || isPacote;

            if (isConvenio) {
                totalInsuranceProduction += valor;
                countInsuranceTotal += 1;
                if (!foiPago) {
                    totalInsurancePending += valor;
                    countInsurancePending += 1;
                    appointmentPendingTotal += valor;
                    appointmentPendingCount += 1;
                }
            } else if (!isPacote && !foiPago) {
                particularPendingTotal += valor;
                particularPendingCount += 1;
                appointmentPendingTotal += valor;
                appointmentPendingCount += 1;
            }
        }

        const totalReceived = p.totalReceived || 0;
        const totalExpenses = exp.totalExpenses || 0;
        const profit = totalReceived - totalExpenses;

        const totals = {
            totalReceived,
            totalProduction: (p.totalProduction || 0) + appointmentPendingTotal, // produção = recebido + a receber
            totalPending: appointmentPendingTotal, // 💰 a receber real do período
            totalPartial,
            countReceived: p.countReceived || 0,
            countPending: appointmentPendingCount,
            countPartial,
            particularReceived: p.particularReceived || 0,
            particularPending: particularPendingTotal,
            particularCountReceived: p.particularCountReceived || 0,
            particularCountPending: particularPendingCount,
            totalInsuranceProduction,
            totalInsuranceReceived: 0, // caixa real de convênio é 0 nesse endpoint (vem do insurance)
            totalInsurancePending,
            countInsuranceTotal,
            countInsuranceReceived: 0,
            countInsurancePending,
            totalCombined: totalReceived + appointmentPendingTotal,
            insurance: { pendingBilling: 0, billed: 0, received: 0 },
            packageCredit: { contractedRevenue: pkg.contractedRevenue || 0, cashReceived: pkg.cashReceived || 0, deferredRevenue: Math.max(0, pkg.deferredRevenue || 0), deferredSessions: Math.max(0, pkg.deferredSessions || 0), recognizedRevenue: pkg.recognizedRevenue || 0, recognizedSessions: pkg.recognizedSessions || 0, totalSessions: pkg.totalSessions || 0, activePackages: pkg.activePackages || 0 },
            patientBalance: { totalDebt: bal.totalDebt || 0, totalCredit: bal.totalCredit || 0, totalDebited: bal.totalDebited || 0, totalCredited: bal.totalCredited || 0, patientsWithDebt: bal.patientsWithDebt || 0, patientsWithCredit: bal.patientsWithCredit || 0 },
            expenses: { total: totalExpenses, pending: exp.totalExpensesPending || 0, count: exp.countExpenses || 0 },
            profit,
            profitMargin: totalReceived > 0 ? Math.round((profit / totalReceived) * 100 * 100) / 100 : 0
        };

        res.json({ success: true, data: { totals, period, date: dateStr, calculatedAt: new Date(), source: 'sync_calculation' }, correlationId });

    } catch (error) {
        log.error('totals_error', error.message);
        res.status(500).json({ success: false, error: error.message, correlationId });
    }
});

router.post('/recalculate', async (req, res) => {
    try {
        const { clinicId, date, period = 'month' } = req.body;
        const targetDate = date || moment.tz(TIMEZONE).format('YYYY-MM-DD');
        await publishEvent(EventTypes.TOTALS_RECALCULATE_REQUESTED, { clinicId: clinicId || 'default', date: targetDate, period });
        res.json({ success: true, message: 'Recálculo solicitado', data: { clinicId, date: targetDate, period } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
