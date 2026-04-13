/**
 * leadRecoveryWorker.js
 *
 * Consome: LEAD_RECOVERY_CANCEL_REQUESTED → fila: lead-recovery
 *
 * Responsabilidade: cancela o recovery de um lead que respondeu,
 * desacoplando essa operação do hot path do processInboundMessage.
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../config/redisConnection.js';
import { moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { cancelRecovery } from '../services/leadRecoveryService.js';
import { createContextLogger } from '../utils/logger.js';

const logger = createContextLogger('leadRecoveryWorker');

export function startLeadRecoveryWorker() {
    const worker = new Worker(
        'lead-recovery',
        async (job) => {
            const { leadId, reason } = job.data.payload ?? job.data;

            if (!leadId) {
                logger.warn('missing_leadId', { jobId: job.id });
                return { status: 'skipped', reason: 'MISSING_LEAD_ID' };
            }

            await cancelRecovery(leadId, reason || 'lead_respondeu');

            logger.info('recovery_cancelled', { leadId, reason });
            return { status: 'done', leadId };
        },
        {
            connection:  bullMqConnection,
            concurrency: 10,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'fixed',
                    delay: 3000
                },
                removeOnComplete: 100,
                removeOnFail: 50
            }
        }
    );

    worker.on('failed', async (job, err) => {
        logger.error('job_failed', { jobId: job?.id, err: err.message, attempts: job?.attemptsMade });
        
        // 🎯 DLQ: mover para fila de mortos após 3 tentativas
        if (job && job.attemptsMade >= 3) {
            await moveToDLQ(job, err, 'lead-recovery-dlq');
            logger.error('moved_to_dlq', { jobId: job.id, queue: 'lead-recovery-dlq' });
        }
    });

    logger.info('worker_started', { queue: 'lead-recovery' });
    return worker;
}
