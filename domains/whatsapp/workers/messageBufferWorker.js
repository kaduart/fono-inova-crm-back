// back/domains/whatsapp/workers/messageBufferWorker.js
/**
 * Message Buffer Worker
 * 
 * Papel: Primeira linha de defesa - Anti-flood, idempotência, debounce
 * 
 * Evento Consumido: WHATSAPP_MESSAGE_RECEIVED
 * Evento Publicado: LEAD_STATE_CHECK_REQUESTED (após validações)
 * 
 * Regras (do documento-analise.txt):
 * - RN-WHATSAPP-001: Lock global (Redis SET NX)
 * - RN-WHATSAPP-002: Buffer de mensagens
 * - RN-WHATSAPP-003: Idempotência (MD5 do conteúdo)
 * - RN-WHATSAPP-004: Debounce (agrupar mensagens rápidas)
 */

import { Worker } from 'bullmq';
import crypto from 'crypto';
import { getRedisConnection } from '../../../infra/redis/redisClient.js';
import { logger } from '../../../infra/logger.js';

const REDIS_LOCK_TTL = 30000; // 30s
const DEBOUNCE_WINDOW = 2000; // 2s
const IDEMPOTENCY_WINDOW = 10000; // 10s

/**
 * Cria o Message Buffer Worker
 * 
 * @param {Object} deps - Dependências
 * @param {Object} deps.redis - Cliente Redis
 * @param {Function} deps.publishEvent - Função para publicar eventos
 */
export function createMessageBufferWorker(deps) {
  const { redis, publishEvent } = deps;

  return new Worker(
    'whatsapp-message-buffer',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const { phone, message, timestamp } = payload;
      const correlationId = metadata?.correlationId || eventId;

      logger.info('[MessageBufferWorker] Processing', {
        phone,
        messagePreview: message?.substring(0, 50),
        correlationId
      });

      try {
        // RN-WHATSAPP-001: Lock Global
        const lockKey = `lock:whatsapp:${phone}`;
        const lockAcquired = await acquireLock(redis, lockKey, REDIS_LOCK_TTL);
        
        if (!lockAcquired) {
          logger.warn('[MessageBufferWorker] Lock exists, requeueing', { phone });
          // Reagenda para processar após o lock expirar
          await job.moveToDelayed(Date.now() + 5000);
          return { status: 'delayed', reason: 'lock_exists' };
        }

        // RN-WHATSAPP-003: Idempotência (MD5 do conteúdo)
        const messageHash = generateMessageHash(phone, message);
        const isDuplicate = await checkIdempotency(redis, messageHash, IDEMPOTENCY_WINDOW);
        
        if (isDuplicate) {
          logger.info('[MessageBufferWorker] Duplicate message ignored', { 
            phone, 
            messageHash 
          });
          return { status: 'ignored', reason: 'duplicate_message' };
        }

        // RN-WHATSAPP-004: Debounce (agrupar mensagens rápidas)
        const debounceKey = `debounce:whatsapp:${phone}`;
        const pendingMessages = await addToDebounceBuffer(redis, debounceKey, payload);
        
        if (pendingMessages.length > 1) {
          logger.info('[MessageBufferWorker] Debouncing messages', { 
            phone, 
            count: pendingMessages.length 
          });
          // Aguarda janela de debounce
          await job.moveToDelayed(Date.now() + DEBOUNCE_WINDOW);
          return { status: 'debouncing', messageCount: pendingMessages.length };
        }

        // Mensagem única ou primeira após debounce
        const aggregatedContent = pendingMessages.length > 1 
          ? pendingMessages.map(m => m.message).join(' ')
          : message;

        // RN-WHATSAPP-002: Buffer processado, avança para próximo estágio
        await publishEvent('LEAD_STATE_CHECK_REQUESTED', {
          originalEventId: eventId,
          phone,
          message: aggregatedContent,
          timestamp,
          messageCount: pendingMessages.length || 1,
          correlationId
        }, { correlationId });

        // Limpa buffer de debounce
        await redis.del(debounceKey);

        logger.info('[MessageBufferWorker] Message buffered, emitted LEAD_STATE_CHECK_REQUESTED', {
          phone,
          correlationId
        });

        return {
          status: 'buffered',
          nextEvent: 'LEAD_STATE_CHECK_REQUESTED',
          phone,
          messageLength: aggregatedContent.length
        };

      } catch (error) {
        logger.error('[MessageBufferWorker] Error', {
          error: error.message,
          phone,
          correlationId
        });
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 20, // Alto para lidar com burst
      limiter: {
        max: 100,
        duration: 1000
      }
    }
  );
}

// ============================================
// HELPERS
// ============================================

async function acquireLock(redis, key, ttl) {
  const result = await redis.set(key, 'locked', 'PX', ttl, 'NX');
  return result === 'OK';
}

function generateMessageHash(phone, message) {
  return crypto
    .createHash('md5')
    .update(`${phone}:${message}`)
    .digest('hex');
}

async function checkIdempotency(redis, hash, windowMs) {
  const key = `idempotency:whatsapp:${hash}`;
  const exists = await redis.exists(key);
  
  if (exists) {
    return true;
  }
  
  // Marca como processado
  await redis.setex(key, Math.ceil(windowMs / 1000), '1');
  return false;
}

async function addToDebounceBuffer(redis, key, message) {
  const now = Date.now();
  const pipeline = redis.pipeline();
  
  // Adiciona mensagem ao sorted set (score = timestamp)
  pipeline.zadd(key, now, JSON.stringify(message));
  
  // Remove mensagens antigas (fora da janela de debounce)
  pipeline.zremrangebyscore(key, 0, now - DEBOUNCE_WINDOW);
  
  // Obtém todas as mensagens na janela
  pipeline.zrange(key, 0, -1);
  
  // Expira a chave
  pipeline.expire(key, Math.ceil(DEBOUNCE_WINDOW / 1000) + 1);
  
  const results = await pipeline.exec();
  const messages = results[2][1].map(m => JSON.parse(m));
  
  return messages;
}

// ============================================
// REGRAS DOCUMENTADAS
// ============================================

export const MessageBufferRules = {
  'RN-WHATSAPP-001': 'Lock global (Redis SET NX) - evita processamento paralelo do mesmo lead',
  'RN-WHATSAPP-002': 'Buffer de mensagens - armazena temporariamente',
  'RN-WHATSAPP-003': 'Idempotência (MD5) - ignora mensagens duplicadas em 10s',
  'RN-WHATSAPP-004': 'Debounce (2s) - agrupa mensagens enviadas em sequência rápida'
};

export default createMessageBufferWorker;
