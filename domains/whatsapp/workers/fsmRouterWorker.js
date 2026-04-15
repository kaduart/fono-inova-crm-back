// domains/whatsapp/workers/fsmRouterWorker.js
/**
 * FSM Router Worker
 *
 * Papel: Rotear a intenção classificada para a ação correta no CRM
 *
 * Evento Consumido: INTENT_CLASSIFIED
 * Ações por intent:
 *
 *   STOP     → ativa manualControl no Lead (Amanda para de responder)
 *   SCHEDULE → salva hint no Redis (Amanda prioriza agendamento)
 *   PRICING  → salva hint no Redis (Amanda responde sobre preços)
 *   DELAY    → salva hint no Redis (Amanda aguarda, reagenda follow-up)
 *   UNKNOWN  → no-op (log apenas)
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import { getRedisConnection } from '../../../infra/redis/redisClient.js';
import { moveToDLQ } from '../../../infrastructure/queue/queueConfig.js';
import logger from '../../../utils/logger.js';
import Lead from '../../../models/Lead.js';

// TTL dos hints de intenção no Redis (em segundos)
const INTENT_HINT_TTL = {
  SCHEDULE: 3600,      // 1h — usuário quer agendar agora
  PRICING:  3600,      // 1h — usuário pergunta preços
  DELAY:    7200,      // 2h — usuário pediu para falar depois
};

/**
 * Chave Redis para hint de intenção
 * Formato: intent:hint:{leadId}
 */
const intentHintKey = (leadId) => `intent:hint:${leadId}`;

// ─── Worker ──────────────────────────────────────────────────────────────────

export function createFsmRouterWorker() {
  const redis = getRedisConnection();

  return new Worker(
    'whatsapp-fsm-router',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const { leadId, messageId, followupId, intent, confidence, originalText } = payload;
      const correlationId = metadata?.correlationId || eventId;

      logger.info('[FsmRouter] Processing', { leadId, intent, confidence, correlationId });

      switch (intent) {

        // ────────────────────────────────────────────────────────────────────
        case 'STOP': {
          // Ativa manualControl — Amanda para de responder a este lead
          const result = await Lead.findByIdAndUpdate(
            leadId,
            {
              $set: {
                'manualControl.active': true,
                'manualControl.takenOverAt': new Date(),
                'manualControl.autoResumeAfter': null,
                'manualControl.reason': 'OPT_OUT_FOLLOWUP',
              },
            },
            { new: false }
          );

          if (!result) {
            logger.warn('[FsmRouter] Lead not found for STOP', { leadId });
            return { status: 'skipped', reason: 'LEAD_NOT_FOUND' };
          }

          // Limpa qualquer hint anterior
          await redis.del(intentHintKey(leadId));

          logger.info('[FsmRouter] STOP — manualControl activated', { leadId, followupId });
          return { status: 'completed', action: 'MANUAL_CONTROL_ACTIVATED' };
        }

        // ────────────────────────────────────────────────────────────────────
        case 'SCHEDULE':
        case 'PRICING':
        case 'DELAY': {
          const ttl = INTENT_HINT_TTL[intent];
          const hintPayload = JSON.stringify({
            intent,
            confidence,
            followupId,
            messageId,
            detectedAt: new Date().toISOString(),
            textSnippet: originalText?.substring(0, 200),
          });

          await redis.setex(intentHintKey(leadId), ttl, hintPayload);

          logger.info('[FsmRouter] Intent hint saved', { leadId, intent, ttl });
          return { status: 'completed', action: 'INTENT_HINT_SAVED', intent, ttl };
        }

        // ────────────────────────────────────────────────────────────────────
        case 'UNKNOWN':
        default: {
          logger.debug('[FsmRouter] UNKNOWN intent — no action', { leadId, messageId });
          return { status: 'skipped', reason: 'UNKNOWN_INTENT' };
        }
      }
    },
    {
      connection: bullMqConnection,
      concurrency: 20,
      limiter: { max: 100, duration: 1000 },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 3000 },
        removeOnComplete: 200,
        removeOnFail: 50,
      },
    }
  );
}

export default createFsmRouterWorker;
