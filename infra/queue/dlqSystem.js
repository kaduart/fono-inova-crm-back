// back/infra/queue/dlqSystem.js
/**
 * Dead Letter Queue (DLQ) System
 * 
 * Sistema completo de DLQ com retry, análise e reprocessamento.
 * 
 * Features:
 * - Retry automático com backoff exponencial
 * - DLQ para mensagens que falharam permanentemente
 * - Análise de padrões de falha
 * - Reprocessamento manual ou automático
 * - Alertas para falhas críticas
 */

import { Queue, Worker } from 'bullmq';
import { getRedis } from '../../services/redisClient.js';
const getRedisConnection = getRedis;
import { createContextLogger } from '../../utils/logger.js';
const logger = createContextLogger(null, 'DLQ');

// ============================================
// CONFIGURAÇÃO
// ============================================

const DLQ_CONFIG = {
  maxRetries: 5,
  retryDelays: [1000, 5000, 15000, 60000, 300000], // 1s, 5s, 15s, 1min, 5min
  dlqRetention: 7 * 24 * 60 * 60 * 1000, // 7 dias
  alertThreshold: 10 // Alertar se >10 mensagens na DLQ em 1 hora
};

// ============================================
// DLQ MANAGER
// ============================================

export class DLQManager {
  constructor(deps) {
    this.redis = deps.redis;
    this.eventStore = deps.eventStore;
    this.notificationService = deps.notificationService;
    
    // Filas de DLQ por domínio
    this.dlqQueues = new Map();
    this.retryQueues = new Map();
  }

  /**
   * Inicializa DLQ para uma fila principal
   */
  initializeDLQForQueue(queueName, options = {}) {
    const dlqName = `${queueName}_dlq`;
    const retryName = `${queueName}_retry`;

    // Fila DLQ
    const dlqQueue = new Queue(dlqName, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false,
        attempts: 1 // DLQ não faz retry
      }
    });

    // Fila de retry
    const retryQueue = new Queue(retryName, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false
      }
    });

    this.dlqQueues.set(queueName, dlqQueue);
    this.retryQueues.set(queueName, retryQueue);

    // Worker de retry
    this.createRetryWorker(queueName, options.processor);

    logger.info(`[DLQ] Initialized for queue: ${queueName}`, {
      dlq: dlqName,
      retry: retryName
    });

    return { dlqQueue, retryQueue };
  }

  /**
   * Decide se deve retry ou mover para DLQ
   */
  async handleFailedJob(queueName, job, error) {
    const attempts = job.attemptsMade + 1;
    const maxRetries = DLQ_CONFIG.maxRetries;

    logger.warn(`[DLQ] Job failed (${attempts}/${maxRetries})`, {
      queue: queueName,
      jobId: job.id,
      error: error.message,
      correlationId: job.data.metadata?.correlationId
    });

    // Ainda tem tentativas?
    if (attempts < maxRetries) {
      // Calcula delay com backoff exponencial
      const delay = this.calculateBackoff(attempts);
      
      logger.info(`[DLQ] Scheduling retry ${attempts} in ${delay}ms`, {
        jobId: job.id,
        correlationId: job.data.metadata?.correlationId
      });

      // Agenda retry na fila de retry
      const retryQueue = this.retryQueues.get(queueName);
      await retryQueue.add(
        job.name,
        {
          ...job.data,
          _retryContext: {
            originalJobId: job.id,
            attemptNumber: attempts,
            lastError: error.message,
            failedAt: new Date().toISOString()
          }
        },
        { delay }
      );

      return { action: 'retry', delay };
    }

    // Max retries atingido - mover para DLQ
    return await this.moveToDLQ(queueName, job, error);
  }

  /**
   * Move mensagem para DLQ
   */
  async moveToDLQ(queueName, job, error) {
    const dlqQueue = this.dlqQueues.get(queueName);
    
    const dlqEntry = {
      originalJob: {
        id: job.id,
        name: job.name,
        data: job.data,
        timestamp: job.timestamp
      },
      failure: {
        message: error.message,
        stack: error.stack,
        attempts: job.attemptsMade + 1,
        failedAt: new Date().toISOString()
      },
      metadata: {
        queue: queueName,
        movedToDlqAt: new Date().toISOString(),
        correlationId: job.data.metadata?.correlationId,
        expiresAt: new Date(Date.now() + DLQ_CONFIG.dlqRetention).toISOString()
      }
    };

    await dlqQueue.add('failed_job', dlqEntry);

    // Alerta se threshold atingido
    await this.checkAlertThreshold(queueName);

    // Registra no Event Store para análise
    await this.recordFailure(queueName, dlqEntry);

    logger.error(`[DLQ] Job moved to DLQ after ${job.attemptsMade + 1} attempts`, {
      queue: queueName,
      jobId: job.id,
      correlationId: job.data.metadata?.correlationId,
      error: error.message
    });

    return { action: 'dlq', dlqEntry };
  }

  /**
   * Cria worker de retry
   */
  createRetryWorker(queueName, processor) {
    const retryQueueName = `${queueName}_retry`;
    
    const worker = new Worker(
      retryQueueName,
      async (job) => {
        const { _retryContext, ...originalData } = job.data;
        
        logger.info(`[DLQ] Processing retry`, {
          queue: queueName,
          attempt: _retryContext.attemptNumber,
          correlationId: originalData.metadata?.correlationId
        });

        try {
          // Processa novamente
          const result = await processor(originalData);
          
          logger.info(`[DLQ] Retry succeeded`, {
            queue: queueName,
            attempt: _retryContext.attemptNumber,
            correlationId: originalData.metadata?.correlationId
          });

          return { status: 'retry_succeeded', result };
        } catch (error) {
          // Se falhar de novo, o BullMQ vai tentar novamente
          // ou mover para DLQ se atingir max retries
          throw error;
        }
      },
      { connection: getRedisConnection() }
    );

    worker.on('failed', async (job, error) => {
      // Se falhou no retry, move para DLQ
      if (job.attemptsMade >= DLQ_CONFIG.maxRetries - 1) {
        await this.moveToDLQ(queueName, job, error);
      }
    });

    return worker;
  }

  /**
   * Calcula backoff exponencial
   */
  calculateBackoff(attempt) {
    if (attempt <= DLQ_CONFIG.retryDelays.length) {
      return DLQ_CONFIG.retryDelays[attempt - 1];
    }
    // Exponential backoff como fallback
    return Math.min(Math.pow(2, attempt) * 1000, 300000); // Max 5min
  }

  /**
   * Verifica threshold de alerta
   */
  async checkAlertThreshold(queueName) {
    const dlqQueue = this.dlqQueues.get(queueName);
    const count = await dlqQueue.getJobCounts();
    
    if (count.waiting > DLQ_CONFIG.alertThreshold) {
      logger.error(`[DLQ] ALERT: High number of failed jobs`, {
        queue: queueName,
        dlqSize: count.waiting,
        threshold: DLQ_CONFIG.alertThreshold
      });

      // Notifica admin
      if (this.notificationService) {
        await this.notificationService.sendAlert({
          type: 'dlq_threshold_exceeded',
          queue: queueName,
          count: count.waiting,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Registra falha no Event Store
   */
  async recordFailure(queueName, dlqEntry) {
    try {
      await this.eventStore.create({
        eventType: 'DLQ_MESSAGE_ADDED',
        correlationId: dlqEntry.originalJob.data.metadata?.correlationId,
        payload: {
          queue: queueName,
          error: dlqEntry.failure.message,
          attempts: dlqEntry.failure.attempts
        },
        timestamp: new Date()
      });
    } catch (error) {
      logger.error('Failed to record DLQ entry', { error: error.message });
    }
  }

  // ============================================
  // REPROCESSAMENTO MANUAL
  // ============================================

  /**
   * Lista mensagens na DLQ
   */
  async listDLQMessages(queueName, options = {}) {
    const dlqQueue = this.dlqQueues.get(queueName);
    const jobs = await dlqQueue.getJobs(['waiting'], 0, options.limit || 100);
    
    return jobs.map(job => ({
      id: job.id,
      failedAt: job.data.metadata.movedToDlqAt,
      error: job.data.failure.message,
      correlationId: job.data.metadata.correlationId,
      originalJob: job.data.originalJob
    }));
  }

  /**
   * Reprocessa mensagem específica da DLQ
   */
  async reprocessDLQMessage(queueName, jobId, processor) {
    const dlqQueue = this.dlqQueues.get(queueName);
    const job = await dlqQueue.getJob(jobId);

    if (!job) {
      throw new Error(`Job ${jobId} not found in DLQ`);
    }

    logger.info(`[DLQ] Reprocessing message manually`, {
      queue: queueName,
      jobId,
      correlationId: job.data.metadata.correlationId
    });

    try {
      // Remove da DLQ
      await job.remove();

      // Reprocessa
      const result = await processor(job.data.originalJob.data);

      logger.info(`[DLQ] Manual reprocess succeeded`, {
        queue: queueName,
        jobId
      });

      return { success: true, result };
    } catch (error) {
      // Se falhar, volta para DLQ
      await this.moveToDLQ(queueName, job.data.originalJob, error);
      
      throw error;
    }
  }

  /**
   * Reprocessa todas as mensagens da DLQ
   */
  async reprocessAllDLQ(queueName, processor) {
    const messages = await this.listDLQMessages(queueName);
    const results = { succeeded: 0, failed: 0, errors: [] };

    for (const message of messages) {
      try {
        await this.reprocessDLQMessage(queueName, message.id, processor);
        results.succeeded++;
      } catch (error) {
        results.failed++;
        results.errors.push({ jobId: message.id, error: error.message });
      }
    }

    return results;
  }

  /**
   * Análise de padrões de falha
   */
  async analyzeFailurePatterns(queueName) {
    const messages = await this.listDLQMessages(queueName, { limit: 1000 });
    
    const patterns = {};
    const hourlyDistribution = new Array(24).fill(0);

    for (const msg of messages) {
      // Agrupa por tipo de erro
      const errorType = msg.error.split(':')[0];
      patterns[errorType] = (patterns[errorType] || 0) + 1;

      // Distribuição horária
      const hour = new Date(msg.failedAt).getHours();
      hourlyDistribution[hour]++;
    }

    return {
      totalMessages: messages.length,
      topErrors: Object.entries(patterns)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      hourlyDistribution,
      peakHour: hourlyDistribution.indexOf(Math.max(...hourlyDistribution))
    };
  }
}

// ============================================
// EXPORTS
// ============================================

export default DLQManager;
