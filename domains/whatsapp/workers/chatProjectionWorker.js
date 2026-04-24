/**
 * Chat Projection Worker (V2 — Read Model)
 *
 * Papel: Manter a projeção read-only do inbox do chat atualizada em tempo real
 * Consome: whatsapp-chat-projection
 *   - MESSAGE_PERSISTED  (inbound) → incrementa unreadCount, atualiza lastMessage
 *   - WHATSAPP_MESSAGE_SENT (outbound) → atualiza lastMessage, NÃO altera unreadCount
 *
 * Objetivo:
 *   - Frontend PARA de fazer Message.find() / aggregates
 *   - inbox em <20ms via ChatProjection.find().sort({ lastMessageAt: -1 })
 *   - unreadCount sempre consistente (escrita via evento, nunca via frontend)
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import { getIo } from '../../../config/socket.js';
import ChatProjection from '../../../models/ChatProjection.js';
import Message from '../../../models/Message.js';
import logger from '../../../utils/logger.js';

export function createChatProjectionWorker() {
  const worker = new Worker(
    'whatsapp-chat-projection',
    async (job) => {
      const { eventType, payload, metadata } = job.data;
      const correlationId = metadata?.correlationId || job.id;
      const leadId = payload.leadId;

      if (!leadId) {
        logger.warn('[ChatProjectionWorker] missing leadId — skipping', { correlationId });
        return { status: 'skipped', reason: 'no_lead' };
      }

      logger.info('[ChatProjectionWorker] processing', { eventType, leadId, correlationId });

      if (eventType === 'MESSAGE_PERSISTED') {
        // ── INBOUND ───────────────────────────────────────────────────────
        const { content, timestamp, type, from, contactId, contactName } = payload;

        await ChatProjection.updateOne(
          { leadId },
          {
            $set: {
              lastMessage: truncate(content, 200),
              lastMessageAt: new Date(timestamp),
              lastDirection: 'inbound',
              lastMessageType: type || 'text',
              phone: from || undefined,
              ...(contactId && { contactId }),
              ...(contactName && { contactName }),
              updatedAt: new Date(),
            },
            $inc: { unreadCount: 1 },
          },
          { upsert: true }
        );

      } else if (eventType === 'WHATSAPP_MESSAGE_SENT') {
        // ── OUTBOUND ──────────────────────────────────────────────────────
        // WHATSAPP_MESSAGE_SENT não carrega content — busca no Message pelo messageId
        let content = payload.content || null;

        if (!content && payload.messageId) {
          try {
            const msg = await Message.findById(payload.messageId).select('content type').lean();
            content = msg?.content || '';
          } catch (err) {
            logger.warn('[ChatProjectionWorker] failed to fetch message content', {
              messageId: payload.messageId, err: err.message,
            });
          }
        }

        await ChatProjection.updateOne(
          { leadId },
          {
            $set: {
              lastMessage: truncate(content || '[mensagem enviada]', 200),
              lastMessageAt: payload.sentAt ? new Date(payload.sentAt) : new Date(),
              lastDirection: 'outbound',
              updatedAt: new Date(),
            },
            // outbound NÃO altera unreadCount (agente leu ao enviar)
          },
          { upsert: true }
        );

      } else {
        logger.warn('[ChatProjectionWorker] unknown eventType', { eventType, leadId });
        return { status: 'skipped', reason: 'unknown_event' };
      }

      // Busca projeção atualizada para emitir via socket
      const projection = await ChatProjection.findOne({ leadId })
        .select('leadId phone contactName lastMessage lastMessageAt lastDirection unreadCount')
        .lean();

      if (projection) {
        try {
          const io = getIo();
          // Atualiza inbox de todos os atendentes conectados
          io?.emit('chat:inbox:update', projection);
          // Atualiza sala específica do lead (ChatWindow aberto)
          io?.to(`chat:${leadId}`).emit('chat:new_message', {
            leadId,
            direction: eventType === 'MESSAGE_PERSISTED' ? 'inbound' : 'outbound',
            lastMessage: projection.lastMessage,
            lastMessageAt: projection.lastMessageAt,
          });
        } catch (socketErr) {
          // Socket.IO só existe no web service — normal em arquitetura separada
          logger.debug('[ChatProjectionWorker] socket emit skipped (worker mode)');
        }
      }

      logger.info('[ChatProjectionWorker] done', { eventType, leadId, correlationId });
      return { status: 'updated', leadId };
    },
    {
      connection: bullMqConnection,
      concurrency: 20,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(`[ChatProjectionWorker] ❌ ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export default createChatProjectionWorker;
