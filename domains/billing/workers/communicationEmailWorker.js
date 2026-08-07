import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../../../infrastructure/queue/queueConfig.js';
import { EmailDeliveryProvider } from '../../../services/communication/delivery/EmailDeliveryProvider.js';
import { handleDeliveryResult } from '../../../services/communication/CommunicationService.js';
import { createContextLogger } from '../../../utils/logger.js';

const logger = createContextLogger('communication_email_worker');

const emailProvider = new EmailDeliveryProvider();

export const communicationEmailWorker = new Worker(
  'communication-email',
  async (job) => {
    const {
      communicationId,
      to,
      subject,
      message,
      template,
      userId,
      sendType,
      ip,
      reason
    } = job.data;

    const startTime = Date.now();
    const queueDelayMs = startTime - job.timestamp;
    logger.info('communication_email_started', `Iniciando envio de comunicação ${communicationId}`, {
      jobId: job.id,
      communicationId,
      to,
      attempt: job.attemptsMade + 1,
      queueDelayMs
    });

    try {
      const result = await emailProvider.executeDelivery({
        communicationId,
        to,
        subject,
        message,
        template,
        userId,
        sendType,
        ip,
        reason,
        jobId: job.id
      });

      const duration = Date.now() - startTime;

      if (!result.success) {
        await handleDeliveryResult(communicationId, result);
        throw result.error;
      }

      await handleDeliveryResult(communicationId, result);

      logger.info('communication_email_completed', `Comunicação ${communicationId} enviada`, {
        jobId: job.id,
        communicationId,
        logId: result.log?._id,
        protocol: result.log?.protocol,
        attempt: result.log?.attempt,
        queueDelayMs,
        processingMs: duration,
        totalMs: queueDelayMs + duration
      });

      return {
        success: true,
        logId: result.log?._id,
        protocol: result.log?.protocol,
        to: result.log?.to,
        attempt: result.log?.attempt,
        queueDelayMs,
        durationMs: duration
      };
    } catch (error) {
      logger.error('communication_email_failed', `Falha no envio da comunicação ${communicationId}: ${error.message}`, {
        jobId: job.id,
        communicationId,
        attempt: job.attemptsMade + 1,
        queueDelayMs,
        processingMs: Date.now() - startTime,
        willRetry: job.attemptsMade < 4
      });

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
    lockDuration: 90000
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
