// workers/totalsWorker.js
import { Worker } from 'bullmq';
import moment from 'moment-timezone';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Payment from '../models/Payment.js';
import TotalsSnapshot from '../models/TotalsSnapshot.js';
import { eventExists } from '../infrastructure/events/eventStoreService.js';

export function startTotalsWorker() {
    console.log('[TotalsWorker] Criando worker...');
    
    const worker = new Worker('totals-calculation', async (job) => {
        console.log('[TotalsWorker] JOB RECEBIDO:', job.id);
        
        const { eventId, correlationId, payload } = job.data;
        const { clinicId, date, period = 'month' } = payload;
        
        console.log(`[TotalsWorker] Processando: ${date}, period: ${period}`);

        try {
            // Idempotência
            const idempotencyKey = `totals_${clinicId}_${date}_${period}`;
            if (await eventExists(idempotencyKey)) {
                console.log('[TotalsWorker] Já processado');
                return { status: 'already_processed' };
            }

            // Cálculo
            const now = moment.tz(date, "America/Sao_Paulo");
            const rangeStart = now.clone().startOf('month').toDate();
            const rangeEnd = now.clone().endOf('month').toDate();

            const matchStage = {
                status: { $ne: 'canceled' },
                $or: [
                    { paymentDate: { $gte: rangeStart.toISOString().split('T')[0], $lte: rangeEnd.toISOString().split('T')[0] } },
                    { paymentDate: { $exists: false }, createdAt: { $gte: rangeStart, $lte: rangeEnd } }
                ]
            };
            if (clinicId) matchStage.clinicId = clinicId;

            console.log('[TotalsWorker] Executando aggregation...');
            const result = await Payment.aggregate([
                { $match: matchStage },
                { $group: {
                    _id: null,
                    totalReceived: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
                    totalPending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] } },
                    countReceived: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
                    countPending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                    particularReceived: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "paid"] }, { $ne: ["$billingType", "convenio"] }] }, "$amount", 0] } }
                }}
            ]);

            const totals = result[0] || { totalReceived: 0, totalPending: 0, countReceived: 0, countPending: 0, particularReceived: 0 };
            console.log('[TotalsWorker] Totais calculados:', totals);

            // Salvar snapshot
            console.log('[TotalsWorker] Salvando snapshot...');
            await TotalsSnapshot.findOneAndUpdate(
                { clinicId: clinicId || 'default', date: now.format('YYYY-MM-DD'), period },
                {
                    clinicId: clinicId || 'default',
                    date: now.format('YYYY-MM-DD'),
                    period,
                    totals: {
                        totalReceived: totals.totalReceived,
                        totalPending: totals.totalPending,
                        countReceived: totals.countReceived,
                        countPending: totals.countPending,
                        particularReceived: totals.particularReceived
                    },
                    calculatedAt: new Date(),
                    calculatedBy: 'totals_worker'
                },
                { upsert: true, new: true }
            );

            console.log('[TotalsWorker] ✅ SUCESSO');
            return { status: 'completed', totals };

        } catch (error) {
            console.error('[TotalsWorker] ❌ ERRO:', error.message);
            console.error(error.stack);
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 3,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    });

    worker.on('completed', (job) => console.log('[TotalsWorker] Job completado:', job.id));
    worker.on('failed', (job, err) => console.error('[TotalsWorker] Job falhou:', job?.id, err.message));

    console.log('[TotalsWorker] Worker iniciado');
    return worker;
}

export default startTotalsWorker;
