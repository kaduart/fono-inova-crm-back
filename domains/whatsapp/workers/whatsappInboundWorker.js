/**
 * WhatsApp Inbound Worker
 *
 * Consome: WHATSAPP_MESSAGE_RECEIVED  →  fila: whatsapp-inbound
 *
 * Responsabilidades:
 *   1. Recebe { msg, value } já com texto combinado (debounce feito no webhook)
 *   2. Delega para processInboundMessage() — lógica Amanda, save no Mongo, socket
 *
 * Idempotência:
 *   - processInboundMessage() já usa processedWamids (in-memory Set) para dedup
 *   - BullMQ deduplica por jobId no mesmo queue (jobId = wamid quando possível)
 *
 * Concurrency: 3 (Amanda é stateful por leadId — paralelismo seguro porque
 *   cada mensagem de um mesmo lead chega sequencialmente pelo debounce)
 *
 * Retry: 2 tentativas com backoff 1s/2s (erros de rede / Mongo transiente)
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import logger from '../../../utils/logger.js';
import { processInboundMessage } from '../../../controllers/whatsappController.js';

export function createWhatsappInboundWorker() {
  return new Worker(
    'whatsapp-inbound',
    async (job) => {
      const { payload, metadata } = job.data;
      const { msg, value } = payload;

      const wamid    = msg?.id || job.id;
      const from     = msg?.from || 'unknown';
      const correlationId = metadata?.correlationId || job.id;

      logger.info('[WhatsappInboundWorker] Processando mensagem inbound', {
        wamid,
        from,
        correlationId,
      });

      const result = await processInboundMessage(msg, value);

      if (result?.duplicate) {
        logger.info('[WhatsappInboundWorker] Mensagem duplicada ignorada', { wamid });
        return { status: 'skipped', reason: 'DUPLICATE', wamid };
      }

      logger.info('[WhatsappInboundWorker] Mensagem processada', { wamid, from });
      return { status: 'processed', wamid };
    },
    {
      connection: bullMqConnection,
      concurrency: 3,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail:     { count: 500 },
      },
    }
  );
}

export default createWhatsappInboundWorker;
