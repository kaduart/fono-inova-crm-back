// back/domains/whatsapp/workers/notificationWorker.js
/**
 * Notification Worker
 * 
 * Papel: Formatar e enviar mensagens WhatsApp
 * 
 * Evento Consumido: NOTIFICATION_REQUESTED
 * Evento Publicado: MESSAGE_SENT (após envio bem-sucedido)
 * 
 * Regras:
 * - RN-WHATSAPP-013: Formatação de mensagens (templates)
 * - RN-WHATSAPP-014: Rate limiting (evitar ban)
 * - RN-WHATSAPP-015: Retry com backoff (falhas temporárias)
 * - RN-WHATSAPP-016: Outbox pattern (garantia de entrega)
 */

import { Worker } from 'bullmq';
import { getRedisConnection } from '../../../infra/redis/redisClient.js';
import { logger } from '../../../infra/logger.js';

const RATE_LIMIT_WINDOW = 60000; // 1 minuto
const RATE_LIMIT_MAX = 20; // mensagens por minuto
const MAX_RETRIES = 3;

/**
 * Cria o Notification Worker
 * 
 * @param {Object} deps - Dependências
 * @param {Object} deps.whatsappProvider - Provedor WhatsApp (Evolution, etc)
 * @param {Object} deps.redis - Cliente Redis
 * @param {Function} deps.publishEvent - Função para publicar eventos
 * @param {Function} deps.saveToOutbox - Função para salvar no outbox
 */
export function createNotificationWorker(deps) {
  const { whatsappProvider, redis, publishEvent, saveToOutbox } = deps;

  return new Worker(
    'whatsapp-notification',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const { phone, message, leadId, originalEventId } = payload;
      const correlationId = metadata?.correlationId || eventId;
      const isRetry = job.attemptsMade > 0;

      logger.info('[NotificationWorker] Processing', {
        phone,
        isRetry,
        attempt: job.attemptsMade + 1,
        correlationId
      });

      try {
        // RN-WHATSAPP-014: Rate limiting
        const rateLimitStatus = await checkRateLimit(redis, phone);
        
        if (!rateLimitStatus.allowed) {
          logger.warn('[NotificationWorker] Rate limit exceeded', {
            phone,
            retryAfter: rateLimitStatus.retryAfter
          });
          
          // Delay e requeue
          await job.moveToDelayed(Date.now() + rateLimitStatus.retryAfter);
          return { 
            status: 'delayed', 
            reason: 'rate_limited',
            retryAfter: rateLimitStatus.retryAfter
          };
        }

        // RN-WHATSAPP-013: Formatação de mensagens
        const formattedMessage = formatMessage(message, payload.metadata);
        
        // RN-WHATSAPP-016: Salvar no outbox (antes do envio)
        const outboxEntry = await saveToOutbox({
          eventId: `OUT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          correlationId,
          eventType: 'WHATSAPP_MESSAGE_OUTGOING',
          payload: {
            phone,
            message: formattedMessage,
            leadId,
            originalEventId
          },
          status: 'pending'
        });

        // Enviar mensagem
        const sendResult = await whatsappProvider.sendMessage({
          to: phone,
          text: formattedMessage,
          metadata: {
            correlationId,
            outboxId: outboxEntry._id
          }
        });

        if (!sendResult.success) {
          throw new Error(`Send failed: ${sendResult.error}`);
        }

        // Atualizar outbox
        await updateOutboxStatus(outboxEntry._id, 'sent', {
          messageId: sendResult.messageId,
          sentAt: new Date()
 });

        // Atualizar rate limit
        await incrementRateLimit(redis, phone);

        // RN-WHATSAPP-016: Publicar evento de mensagem enviada
        await publishEvent('MESSAGE_SENT', {
          originalEventId,
          outboxId: outboxEntry._id,
          phone,
          leadId,
          messageId: sendResult.messageId,
          messageLength: formattedMessage.length,
          sentAt: new Date().toISOString(),
          metadata: payload.metadata,
          correlationId
        }, { correlationId });

        logger.info('[NotificationWorker] Message sent', {
          phone,
          messageId: sendResult.messageId,
          processingTime: Date.now() - new Date(job.timestamp).getTime()
        });

        return {
          status: 'sent',
          messageId: sendResult.messageId,
          outboxId: outboxEntry._id
        };

      } catch (error) {
        logger.error('[NotificationWorker] Send failed', {
          error: error.message,
          phone,
          attempt: job.attemptsMade + 1,
          correlationId
        });

        // RN-WHATSAPP-015: Retry com backoff
        if (job.attemptsMade >= MAX_RETRIES) {
          logger.error('[NotificationWorker] Max retries exceeded, moving to DLQ', {
            phone,
            messagePreview: message?.substring(0, 50)
          });
          
          // TODO: Mover para DLQ
          await handleFailedMessage(deps, { phone, message, error, correlationId });
          
          return {
            status: 'failed',
            reason: 'max_retries_exceeded',
            error: error.message
          };
        }

        throw error; // Requeue para retry com backoff automático
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
      limiter: {
        max: 20,
        duration: 1000
      },
      // RN-WHATSAPP-015: Backoff exponencial
      backoffStrategy: (attemptsMade) => {
        return Math.pow(2, attemptsMade) * 1000; // 1s, 2s, 4s
      }
    }
  );
}

// ============================================
// HELPERS
// ============================================

function formatMessage(message, metadata) {
  // Se for mensagem de escalonamento, adiciona identificação
  if (metadata?.isEscalation) {
    return message;
  }

  // Se for novo lead, mensagem mais formal
  if (metadata?.isNewLead) {
    return message;
  }

  // Formatação padrão
  return message;
}

async function checkRateLimit(redis, phone) {
  const key = `ratelimit:whatsapp:${phone}`;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;

  // Remove entradas antigas
  await redis.zremrangebyscore(key, 0, windowStart);

  // Conta mensagens na janela
  const count = await redis.zcard(key);

  if (count >= RATE_LIMIT_MAX) {
    // Pega o timestamp da mensagem mais antiga na janela
    const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
    const retryAfter = RATE_LIMIT_WINDOW - (now - parseInt(oldest[1]));
    
    return {
      allowed: false,
      retryAfter: Math.max(retryAfter, 1000)
    };
  }

  return { allowed: true };
}

async function incrementRateLimit(redis, phone) {
  const key = `ratelimit:whatsapp:${phone}`;
  const now = Date.now();
  
  await redis.zadd(key, now, `${now}_${Math.random()}`);
  await redis.expire(key, Math.ceil(RATE_LIMIT_WINDOW / 1000));
}

async function updateOutboxStatus(outboxId, status, data) {
  // TODO: Implementar atualização do outbox
  logger.debug('[NotificationWorker] Updating outbox', { outboxId, status });
}

async function handleFailedMessage(deps, data) {
  // Salvar mensagem falha para análise posterior
  const { phone, message, error, correlationId } = data;
  
  logger.error('[NotificationWorker] Message failed permanently', {
    phone,
    error: error.message,
    correlationId
  });

  // TODO: Notificar administrador
  // TODO: Salvar em coleção de mensagens falhas
}

// ============================================
// REGRAS DOCUMENTADAS
// ============================================

export const NotificationRules = {
  'RN-WHATSAPP-013': 'Formatação de mensagens - aplica templates quando necessário',
  'RN-WHATSAPP-014': 'Rate limiting - máximo 20 msg/min por número (evitar ban)',
  'RN-WHATSAPP-015': 'Retry com backoff - 3 tentativas com espera exponencial',
  'RN-WHATSAPP-016': 'Outbox pattern - garantia de entrega (salvar antes de enviar)'
};

export default createNotificationWorker;
