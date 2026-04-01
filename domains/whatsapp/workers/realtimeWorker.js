// back/domains/whatsapp/workers/realtimeWorker.js
/**
 * Realtime Worker
 * 
 * Papel: Emitir eventos em tempo real via Socket.io e atualizar dashboards
 * 
 * Evento Consumido: MESSAGE_SENT
 * Eventos Socket Emitted: new_message, conversation_update, dashboard_stats
 * 
 * Regras:
 * - RN-WHATSAPP-017: Socket.io rooms (salas por lead)
 * - RN-WHATSAPP-018: Broadcast seletivo (enviar só para quem precisa)
 * - RN-WHATSAPP-019: Dashboard aggregation (métricas em tempo real)
 * - RN-WHATSAPP-020: Offline handling (queue para reconexão)
 */

import { Worker } from 'bullmq';
import { getRedisConnection } from '../../../infra/redis/redisClient.js';
import { logger } from '../../../infra/logger.js';

/**
 * Cria o Realtime Worker
 * 
 * @param {Object} deps - Dependências
 * @param {Object} deps.io - Instância Socket.io
 * @param {Object} deps.redis - Cliente Redis
 * @param {Object} deps.analyticsService - Serviço de analytics
 */
export function createRealtimeWorker(deps) {
  const { io, redis, analyticsService } = deps;

  return new Worker(
    'whatsapp-realtime',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const { phone, leadId, messageId, sentAt, originalEventId } = payload;
      const correlationId = metadata?.correlationId || eventId;

      logger.info('[RealtimeWorker] Processing', {
        phone,
        leadId,
        correlationId
      });

      try {
        const results = await Promise.allSettled([
          // RN-WHATSAPP-017: Emitir para sala do lead
          emitToLeadRoom(io, leadId, {
            type: 'message_sent',
            data: {
              phone,
              messageId,
              sentAt,
              metadata: payload.metadata,
              correlationId
            }
          }),

          // RN-WHATSAPP-018: Broadcast para atendentes
          emitToAttendees(io, {
            type: 'conversation_update',
            data: {
              leadId,
              phone,
              lastMessageAt: sentAt,
              direction: 'outgoing',
              correlationId
            }
          }),

          // RN-WHATSAPP-019: Atualizar dashboard stats
          updateDashboardStats(redis, analyticsService, {
            eventType: 'message_sent',
            phone,
            leadId,
            timestamp: sentAt,
            isEscalation: payload.metadata?.isEscalation,
            isNewLead: payload.metadata?.isNewLead
          }),

          // RN-WHATSAPP-020: Salvar para usuários offline
          queueForOfflineUsers(redis, leadId, {
            type: 'message_sent',
            data: payload,
            correlationId
          })
        ]);

        // Log falhas parciais
        const failures = results.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
          logger.warn('[RealtimeWorker] Some realtime updates failed', {
            phone,
            failures: failures.map(f => f.reason?.message)
          });
        }

        logger.info('[RealtimeWorker] Realtime updates completed', {
          phone,
          socketEmitted: results[0].status === 'fulfilled',
          dashboardUpdated: results[2].status === 'fulfilled'
        });

        return {
          status: 'completed',
          socketEmitted: results[0].status === 'fulfilled',
          broadcastSent: results[1].status === 'fulfilled',
          dashboardUpdated: results[2].status === 'fulfilled',
          offlineQueued: results[3].status === 'fulfilled'
        };

      } catch (error) {
        logger.error('[RealtimeWorker] Error', {
          error: error.message,
          phone,
          correlationId
        });
        
        // Realtime é best-effort, não falha o job
        return {
          status: 'completed_with_errors',
          error: error.message
        };
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 20,
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

async function emitToLeadRoom(io, leadId, event) {
  if (!leadId || !io) return;

  const room = `lead:${leadId}`;
  
  io.to(room).emit(event.type, event.data);
  
  logger.debug('[RealtimeWorker] Emitted to lead room', {
    room,
    eventType: event.type
  });
}

async function emitToAttendees(io, event) {
  if (!io) return;

  // Emite para sala de atendentes
  io.to('attendees').emit(event.type, event.data);
  
  // Se for escalonamento, emite também para sala de prioridade
  if (event.data.isEscalation) {
    io.to('priority-attendees').emit('escalation_alert', event.data);
  }

  logger.debug('[RealtimeWorker] Broadcast to attendees', {
    eventType: event.type,
    isEscalation: event.data.isEscalation
  });
}

async function updateDashboardStats(redis, analyticsService, data) {
  const { eventType, isEscalation, isNewLead } = data;

  // Incrementa contadores em Redis ( rápido )
  const pipeline = redis.pipeline();
  
  pipeline.incr('stats:messages:sent:today');
  pipeline.incr('stats:messages:sent:hour');
  
  if (isEscalation) {
    pipeline.incr('stats:escalations:today');
  }
  
  if (isNewLead) {
    pipeline.incr('stats:leads:new:today');
  }
  
  await pipeline.exec();

  // Atualiza analytics (assíncrono, não bloqueia)
  if (analyticsService) {
    analyticsService.track('whatsapp_message_sent', {
      ...data,
      timestamp: new Date()
    }).catch(err => {
      logger.warn('[RealtimeWorker] Analytics track failed', { error: err.message });
    });
  }

  logger.debug('[RealtimeWorker] Dashboard stats updated');
}

async function queueForOfflineUsers(redis, leadId, event) {
  if (!leadId) return;

  // Salva evento para usuários que estão offline
  const key = `offline:events:${leadId}`;
  const eventData = JSON.stringify({
    ...event,
    queuedAt: Date.now()
  });

  await redis.lpush(key, eventData);
  await redis.expire(key, 86400); // 24h

  // Limita tamanho da fila (mantém últimos 100)
  await redis.ltrim(key, 0, 99);

  logger.debug('[RealtimeWorker] Queued for offline users', { leadId });
}

/**
 * Função auxiliar para recuperar eventos offline
 * (chamada quando usuário reconecta)
 */
export async function getOfflineEvents(redis, leadId) {
  const key = `offline:events:${leadId}`;
  const events = await redis.lrange(key, 0, -1);
  
  // Limpa após recuperar
  await redis.del(key);
  
  return events.map(e => JSON.parse(e));
}

// ============================================
// REGRAS DOCUMENTADAS
// ============================================

export const RealtimeRules = {
  'RN-WHATSAPP-017': 'Socket.io rooms - cada lead tem sala para updates privados',
  'RN-WHATSAPP-018': 'Broadcast seletivo - enviar só para atendentes relevantes',
  'RN-WHATSAPP-019': 'Dashboard aggregation - atualizar métricas em tempo real',
  'RN-WHATSAPP-020': 'Offline handling - queue eventos para usuários offline'
};

export default createRealtimeWorker;
