/**
 * whatsappWebSendWorker.js
 *
 * Consome: fila `whatsapp-send` (BullMQ)
 * Publicada por: POST /api/whatsapp-web/send (back/routes/whatsappWebJs.js)
 *   — usado hoje pelo app `agenda` para confirmações de agendamento.
 *
 * Envia via WhatsApp Web.js (sessão de navegador, sendMessage() em
 * whatsappWebJsService.js) — client já inicializado no boot do worker
 * (workers/startWorkers.js → initWhatsAppClient()).
 *
 * Histórico: até 2026-07-24 essa fila não tinha consumidor no processo que
 * roda em produção (crm-worker → workers/startWorkers.js). O único
 * `new Worker('whatsapp-send', ...)` existia em workers/entrypoints/
 * whatsapp-child.js, que só roda no entrypoint de emergência
 * (whatsapp-only.js), não usado em produção. Jobs ficavam em `waiting` para
 * sempre, sem nenhum log. Ver: whatsappQueueControlService.js (kill switch
 * que já assumia a existência deste consumidor).
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import { sendMessage } from '../../../services/whatsappWebJsService.js';
import { createContextLogger } from '../../../utils/logger.js';

const logger = createContextLogger('whatsappWebSendWorker');

export function createWhatsappWebSendWorker() {
  logger.info('REGISTRADO — pronto para consumir fila whatsapp-send');

  const worker = new Worker(
    'whatsapp-send',
    async (job) => {
      const { phone, message } = job.data;
      logger.info('Enviando via WhatsApp Web.js', { jobId: job.id, phone });

      const result = await sendMessage(phone, message);

      logger.info('Envio concluído', { jobId: job.id, phone });
      return result;
    },
    {
      connection: bullMqConnection,
      limiter: { max: 5, duration: 1000 },
    }
  );

  worker.on('completed', (job) => {
    logger.info('Job completado', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('Job falhou', { jobId: job?.id, error: err.message });
  });

  return worker;
}

export default createWhatsappWebSendWorker;
