/**
 * Lead Interaction Worker
 *
 * Papel: Atualizar lastInteractionAt e histórico de interações do Lead
 * Consome: whatsapp-lead-interaction (evento MESSAGE_PERSISTED)
 *
 * Non-critical: falha aqui não afeta o fluxo principal do chat.
 * BullMQ retentará automaticamente com backoff.
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import Lead from '../../../models/Leads.js';
import logger from '../../../utils/logger.js';

export function createLeadInteractionWorker() {
  const worker = new Worker(
    'whatsapp-lead-interaction',
    async (job) => {
      const { payload, metadata } = job.data;
      const { leadId, from, content, timestamp } = payload;
      const correlationId = metadata?.correlationId || job.id;

      if (!leadId) {
        logger.warn('[LeadInteractionWorker] no leadId, skipping', { from, correlationId });
        return { status: 'skipped', reason: 'no_lead' };
      }

      logger.info('[LeadInteractionWorker] updating lead', { leadId, correlationId });

      await Lead.findByIdAndUpdate(leadId, {
        $set: { lastInteractionAt: new Date() },
        $push: {
          interactions: {
            date: new Date(timestamp),
            channel: 'whatsapp',
            direction: 'inbound',
            message: content,
          },
        },
      });

      logger.info('[LeadInteractionWorker] done', { leadId, correlationId });
      return { status: 'updated', leadId };
    },
    {
      connection: bullMqConnection,
      concurrency: 10,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info(`[LeadInteractionWorker] ✅ ${job.id} done`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[LeadInteractionWorker] ❌ ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

export default createLeadInteractionWorker;
