// back/domains/whatsapp/workers/realtimeWorker.js
/**
 * Realtime Worker
 *
 * Papel: Emitir eventos em tempo real via Socket.io e atualizar dashboards
 *
 * Eventos Consumidos (fila whatsapp-realtime):
 *   - MESSAGE_PERSISTED  → inbound  (vindo do messagePersistenceWorker)
 *   - WHATSAPP_MESSAGE_SENT → outbound (opcional — sendWorker já emite diretamente)
 *
 * Regras:
 * - RN-WHATSAPP-017: Socket.io rooms (salas por lead)
 * - RN-WHATSAPP-018: Broadcast seletivo (enviar só para quem precisa)
 * - RN-WHATSAPP-019: Dashboard aggregation (métricas em tempo real)
 * - RN-WHATSAPP-020: Offline handling (queue para reconexão)
 */

import { Worker } from 'bullmq';
import { bullMqConnection, redisConnection as redis } from '../../../config/redisConnection.js';
import { getIo } from '../../../config/socket.js';
import logger from '../../../utils/logger.js';

export function createRealtimeWorker() {
  return new Worker(
    'whatsapp-realtime',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const correlationId = metadata?.correlationId || eventId;
      const io = getIo();

      // Detecta direção para rotear payload corretamente
      const direction = payload.direction || 'outbound';

      logger.info('[RealtimeWorker] Processing', {
        direction,
        leadId: payload.leadId,
        correlationId,
      });

      try {
        if (direction === 'inbound') {
          // ── INBOUND: MESSAGE_PERSISTED ──────────────────────────────────
          const { messageId, leadId, from, to, type, content, timestamp } = payload;

          const socketPayload = {
            id: messageId,
            from,
            to,
            type,
            content,
            timestamp,
            direction: 'inbound',
          };

          // Broadcast global (compatibilidade com frontend atual)
          io?.emit('message:new', socketPayload);
          io?.emit('whatsapp:new_message', socketPayload);

          // RN-WHATSAPP-017: Sala do lead (seletivo)
          if (leadId) {
            await emitToLeadRoom(io, leadId, { type: 'message_received', data: socketPayload });
          }

          // RN-WHATSAPP-018: Atendentes
          await emitToAttendees(io, {
            type: 'conversation_update',
            data: { leadId, phone: from, lastMessageAt: timestamp, direction: 'inbound', correlationId },
          });

          // RN-WHATSAPP-020: Offline queue
          if (leadId) {
            await queueForOfflineUsers(redis, leadId, { type: 'message_received', data: socketPayload, correlationId });
          }

          // RN-WHATSAPP-019: Stats
          await updateDashboardStats({ eventType: 'message_received', phone: from, leadId, timestamp });

        } else {
          // ── OUTBOUND: WHATSAPP_MESSAGE_SENT ────────────────────────────
          const { phone, leadId, messageId, sentAt } = payload;

          const results = await Promise.allSettled([
            emitToLeadRoom(io, leadId, {
              type: 'message_sent',
              data: { phone, messageId, sentAt, correlationId },
            }),
            emitToAttendees(io, {
              type: 'conversation_update',
              data: { leadId, phone, lastMessageAt: sentAt, direction: 'outgoing', correlationId },
            }),
            updateDashboardStats({
              eventType: 'message_sent',
              phone,
              leadId,
              timestamp: sentAt,
              isEscalation: payload.metadata?.isEscalation,
              isNewLead: payload.metadata?.isNewLead,
            }),
            queueForOfflineUsers(redis, leadId, { type: 'message_sent', data: payload, correlationId }),
          ]);

          const failures = results.filter(r => r.status === 'rejected');
          if (failures.length > 0) {
            logger.warn('[RealtimeWorker] Partial failures (outbound)', {
              failures: failures.map(f => f.reason?.message),
            });
          }
        }

        return { status: 'completed', direction };

      } catch (error) {
        logger.error('[RealtimeWorker] Error', { error: error.message, correlationId });
        // Realtime é best-effort — não falha o job para não bloquear retry
        return { status: 'completed_with_errors', error: error.message };
      }
    },
    {
      connection: bullMqConnection,
      concurrency: 20,
      limiter: { max: 100, duration: 1000 },
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
  logger.debug('[RealtimeWorker] Emitted to lead room', { room, eventType: event.type });
}

async function emitToAttendees(io, event) {
  if (!io) return;
  io.to('attendees').emit(event.type, event.data);
  if (event.data?.isEscalation) {
    io.to('priority-attendees').emit('escalation_alert', event.data);
  }
  logger.debug('[RealtimeWorker] Broadcast to attendees', { eventType: event.type });
}

async function updateDashboardStats(data) {
  const { eventType, isEscalation, isNewLead } = data;
  try {
    const pipeline = redis.pipeline();
    const counterKey = eventType === 'message_received'
      ? 'stats:messages:received:today'
      : 'stats:messages:sent:today';
    pipeline.incr(counterKey);
    if (isEscalation) pipeline.incr('stats:escalations:today');
    if (isNewLead) pipeline.incr('stats:leads:new:today');
    await pipeline.exec();
  } catch (err) {
    logger.warn('[RealtimeWorker] Stats update failed', { error: err.message });
  }
  logger.debug('[RealtimeWorker] Dashboard stats updated', { eventType });
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
