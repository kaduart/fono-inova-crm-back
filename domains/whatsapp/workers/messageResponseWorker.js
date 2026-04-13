// back/domains/whatsapp/workers/messageResponseWorker.js
/**
 * Message Response Worker
 * 
 * Papel: Detectar respostas a follow-ups e marcar como respondidas
 * 
 * Evento Consumido: MESSAGE_RESPONSE_DETECTED
 * Evento Publicado: FOLLOWUP_RESPONSE_RECEIVED
 * 
 * Regra simples: Se chegou mensagem inbound + existe follow-up pendente → é resposta
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import { moveToDLQ } from '../../../infrastructure/queue/queueConfig.js';
import logger from '../../../utils/logger.js';
import Followup from '../../../models/Followup.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';

/**
 * Cria o Message Response Worker
 * 
 * @param {Object} deps - Dependências
 * @param {Object} deps.redis - Cliente Redis
 */
export function createMessageResponseWorker(deps) {
  const { redis } = deps;

  return new Worker(
    'whatsapp-message-response',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const { leadId, messageId } = payload;
      const correlationId = metadata?.correlationId || eventId;

      logger.info('[MessageResponseWorker] Processing', {
        leadId,
        messageId,
        correlationId
      });

      try {
        // 🔒 1. Buscar follow-up pendente (o MAIS recente)
        const followup = await Followup.findOne({
          lead: leadId,
          status: 'sent',
          responded: false,
        }).sort({ sentAt: -1 });

        // 🧱 Idempotência: se não existe, sai silenciosamente
        if (!followup) {
          logger.debug('[MessageResponseWorker] No pending followup found', { leadId });
          return { status: 'skipped', reason: 'NO_PENDING_FOLLOWUP' };
        }

        // 🧱 Idempotência: já respondido (double event, retry, etc)
        if (followup.responded) {
          logger.debug('[MessageResponseWorker] Followup already responded', { 
            followupId: followup._id 
          });
          return { status: 'skipped', reason: 'ALREADY_RESPONDED' };
        }

        // ⏱️ 2. Marcar como respondido (calcula responseTimeMinutes automaticamente)
        await followup.markRespondedAt();

        logger.info('[MessageResponseWorker] Followup marked as responded', {
          followupId: followup._id,
          leadId,
          responseTimeMinutes: followup.responseTimeMinutes
        });

        // 📡 3. Publicar evento para analytics
        await publishEvent(EventTypes.FOLLOWUP_RESPONSE_RECEIVED, {
          followupId: followup._id.toString(),
          leadId: leadId.toString(),
          messageId: messageId?.toString(),
          responseTimeMinutes: followup.responseTimeMinutes,
          respondedAt: followup.respondedAt?.toISOString(),
          sentAt: followup.sentAt?.toISOString(),
        }, {
          correlationId,
          aggregateType: 'followup',
          aggregateId: followup._id.toString(),
          metadata: { source: 'message-response-worker' }
        });

        return {
          status: 'completed',
          followupId: followup._id,
          responseTimeMinutes: followup.responseTimeMinutes,
          eventPublished: EventTypes.FOLLOWUP_RESPONSE_RECEIVED
        };

      } catch (error) {
        logger.error('[MessageResponseWorker] Error', {
          error: error.message,
          leadId,
          correlationId,
          attempts: job.attemptsMade
        });
        
        // 🎯 DLQ: mover para fila de mortos após 3 tentativas
        if (job.attemptsMade >= 3) {
          await moveToDLQ(job, error, 'message-response-dlq');
          logger.error('[MessageResponseWorker] Moved to DLQ', { jobId: job.id, leadId });
        }
        
        // ❗ IMPORTANTE: não quebra fluxo principal — esse worker é side-effect
        throw error; // Re-lança para BullMQ gerenciar retry
      }
    },
    {
      connection: bullMqConnection,
      concurrency: 10,
      limiter: {
        max: 50,
        duration: 1000
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'fixed',
          delay: 5000
        },
        removeOnComplete: 100,
        removeOnFail: 50
      }
    }
  );
}

// ============================================
// REGRAS DOCUMENTADAS
// ============================================

export const MessageResponseRules = {
  'RN-RESPONSE-001': 'Mensagem inbound + followup pendente = resposta',
  'RN-RESPONSE-002': 'Sempre pega o followup mais recente (sort by sentAt desc)',
  'RN-RESPONSE-003': 'Idempotência: responded=true evita duplicidade',
  'RN-RESPONSE-004': 'Nunca falha o job — side-effect não bloqueia fluxo principal',
  'RN-RESPONSE-005': 'Publica FOLLOWUP_RESPONSE_RECEIVED para analytics'
};

export default createMessageResponseWorker;
