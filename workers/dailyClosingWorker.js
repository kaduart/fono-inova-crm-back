// workers/dailyClosingWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { calculateDailyClosing } from '../services/dailyClosingService.js';
import DailyClosingSnapshot from '../models/DailyClosingSnapshot.js';
import { eventExists } from '../infrastructure/events/eventStoreService.js';

export function startDailyClosingWorker() {
    console.log('[DailyClosingWorker] Criando worker...');

    const worker = new Worker('daily-closing', async (job) => {
        const { eventId, payload } = job.data;
        const { date, clinicId } = payload;

        console.log(`[DailyClosingWorker] JOB: ${eventId} | Data: ${date}`);

        try {
            // Idempotência
            const idempotencyKey = `daily_closing_${clinicId || 'default'}_${date}`;
            if (await eventExists(idempotencyKey)) {
                console.log('[DailyClosingWorker] Já processado');
                return { status: 'already_processed' };
            }

            // Cálculo completo via Service
            const report = await calculateDailyClosing(date, clinicId);

            // Salvar snapshot
            await DailyClosingSnapshot.findOneAndUpdate(
                { date, clinicId: clinicId || 'default' },
                {
                    date,
                    clinicId: clinicId || 'default',
                    report,
                    calculatedAt: new Date()
                },
                { upsert: true }
            );

            console.log(`[DailyClosingWorker] ✅ SUCESSO: ${date}`);
            return { status: 'completed', appointments: report.summary.appointments.total };

        } catch (error) {
            console.error('[DailyClosingWorker] ❌ ERRO:', error.message);
            if (job.attemptsMade >= 3) await moveToDLQ(job, error);
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 2,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    });

    console.log('[DailyClosingWorker] Worker iniciado');
    return worker;
}

export default startDailyClosingWorker;
