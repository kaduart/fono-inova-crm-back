import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../../../infrastructure/queue/queueConfig.js';
import { sendCommunicationEmail } from '../../../services/communication/CommunicationEmailService.js';
import { createContextLogger } from '../../../utils/logger.js';

const logger = createContextLogger('communication_email_worker');

export const communicationEmailWorker = new Worker(
  'communication-email',
  async (job) => {
    const {
      communicationId,
      to,
      subject,
      message,
      template,
      userId
    } = job.data;

    const startTime = Date.now();
    logger.info('communication_email_started', `Iniciando envio de comunicação ${communicationId}`, {
      jobId: job.id,
      communicationId,
      to,
      attempt: job.attemptsMade + 1
    });

    try {
      const result = await sendCommunicationEmail({
        communicationId,
        to,
        subject,
        message,
        template,
        userId
      });

      const duration = Date.now() - startTime;
      logger.info('communication_email_completed', `Comunicação ${communicationId} enviada`, {
        jobId: job.id,
        communicationId,
        logId: result.logId,
        protocol: result.protocol,
        attempt: result.attempt,
        durationMs: duration
      });

      return {
        success: true,
        logId: result.logId,
        protocol: result.protocol,
        to: result.to,
        attempt: result.attempt,
        durationMs: duration
      };
    } catch (error) {
      logger.error('communication_email_failed', `Falha no envio da comunicação ${communicationId}: ${error.message}`, {
        jobId: job.id,
        communicationId,
        attempt: job.attemptsMade + 1,
        willRetry: job.attemptsMade < 4
      });

      // Última tentativa: move para DLQ. O status já foi restaurado para READY por sendCommunicationEmail.
      if (job.attemptsMade >= 4) {
        await moveToDLQ(job, error);
      }

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
    limiter: { max: 20, duration: 60000 },
    stalledInterval: 30000,
    lockDuration: 30000
  }
);

communicationEmailWorker.on('completed', (job, result) => {
  logger.info('job_completed', `Job ${job.id} finalizado`, result);
});

communicationEmailWorker.on('failed', (job, err) => {
  logger.error('job_failed', `Job ${job?.id} falhou: ${err.message}`, {
    communicationId: job?.data?.communicationId,
    attempts: job?.attemptsMade
  });
});

console.log('[CommunicationEmailWorker] Worker iniciado');

export default communicationEmailWorker;
