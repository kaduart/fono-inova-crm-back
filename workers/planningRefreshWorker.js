// workers/planningRefreshWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { updatePlanningProgress, updateAllPlanningsProgress } from '../services/planningService.js';
import Planning from '../models/Planning.js';

const REFRESH_CONCURRENCY = 2;

export function startPlanningRefreshWorker() {
    console.log('[PlanningRefreshWorker] Criando worker...');

    const worker = new Worker('planning-refresh', async (job) => {
        const { name, data } = job;

        console.log(`[PlanningRefreshWorker] JOB ${job.id}: ${name}`);

        try {
            if (name === 'refresh-planning') {
                const { planningId } = data;
                if (!planningId) throw new Error('planningId obrigatório');

                await Planning.findByIdAndUpdate(planningId, {
                    calculationStatus: 'processing',
                    lastCalculationError: null
                });

                const updated = await updatePlanningProgress(planningId);
                console.log(`[PlanningRefreshWorker] ✅ Planejamento ${planningId} atualizado`);
                return { status: 'completed', planningId };
            }

            if (name === 'refresh-all') {
                // Processa todos os planejamentos ativos em batches controlados
                const result = await updateAllPlanningsProgress();
                console.log(`[PlanningRefreshWorker] ✅ ${result.updated} planejamentos atualizados`);
                return { status: 'completed', ...result };
            }

            if (name === 'refresh-batch') {
                const { planningIds = [] } = data;
                console.log(`[PlanningRefreshWorker] 🔄 Atualizando batch de ${planningIds.length} planejamentos (concurrency=${REFRESH_CONCURRENCY})...`);

                for (let i = 0; i < planningIds.length; i += REFRESH_CONCURRENCY) {
                    const batch = planningIds.slice(i, i + REFRESH_CONCURRENCY);
                    await Promise.all(
                        batch.map(id =>
                            updatePlanningProgress(id).catch(err => {
                                console.error(`[PlanningRefreshWorker] ❌ Erro ao atualizar ${id}:`, err.message);
                                return { id, status: 'error', error: err.message };
                            })
                        )
                    );
                }

                console.log(`[PlanningRefreshWorker] ✅ Batch de ${planningIds.length} planejamentos processado`);
                return { status: 'completed', count: planningIds.length };
            }

            throw new Error(`Job desconhecido: ${name}`);

        } catch (error) {
            console.error(`[PlanningRefreshWorker] ❌ ERRO no job ${job.id}:`, error.message);
            if (job.attemptsMade >= 3) await moveToDLQ(job, error);
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: REFRESH_CONCURRENCY,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    });

    console.log('[PlanningRefreshWorker] Worker iniciado');
    return worker;
}

export default startPlanningRefreshWorker;
