/**
 * Message Persistence Worker
 *
 * Papel: Persistir mensagem inbound no MongoDB (extrai do monolito processInboundMessage)
 * Consome: whatsapp-persistence (evento WHATSAPP_MESSAGE_PREPROCESSED)
 * Publica: MESSAGE_PERSISTED → [whatsapp-lead-interaction, whatsapp-realtime]
 * Fire-and-forget: CONVERSATION_STATE_UPDATE, MESSAGE_RESPONSE_DETECTED,
 *                  CONTEXT_BUILD_REQUESTED, FOLLOWUP_REQUESTED, LEAD_RECOVERY_CANCEL_REQUESTED
 *
 * CRITICAL: único ponto de falha real. Se Message.create falha → throw → BullMQ retry.
 * Todo o resto é non-critical (log + continua).
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { extractMessageContent } from '../../../utils/whatsappMediaExtractor.js';
import { normalizeE164BR } from '../../../utils/phone.js';
import { resolveLeadByPhone } from '../../../controllers/leadController.js';
import Contacts from '../../../models/Contacts.js';
import Message from '../../../models/Message.js';
import logger from '../../../utils/logger.js';

export function createMessagePersistenceWorker() {
  const worker = new Worker(
    'whatsapp-persistence',
    async (job) => {
      const { payload, metadata } = job.data;
      const { msg, value, combinedText } = payload;
      const wamid = msg.id;
      const correlationId = metadata?.correlationId || `inbound:${wamid}`;

      const from = normalizeE164BR(msg.from || '');
      const to = normalizeE164BR(
        value?.metadata?.display_phone_number || process.env.CLINIC_PHONE_E164
      ) || '0000000000000';
      const type = msg.type;

      logger.info('[MessagePersistenceWorker] start', { wamid, from, type, correlationId });

      // ── 1. EXTRACT CONTENT ────────────────────────────────────────────────
      let contentToSave = combinedText || ''; // debounce already merged
      let mediaUrl = null;
      let mediaId = null;
      let caption = null;

      if (!combinedText) {
        try {
          const extracted = await extractMessageContent(msg, type);
          contentToSave = extracted.content;
          mediaUrl = extracted.mediaUrl;
          mediaId = extracted.mediaId;
          caption = extracted.caption;
        } catch (err) {
          logger.warn('[MessagePersistenceWorker] extract_failed', { err: err.message });
          contentToSave = '[UNREADABLE MESSAGE]';
        }
      }

      const timestamp = new Date(
        (parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000
      );

      // ── 2. CONTACT UPSERT (non-critical) ──────────────────────────────────
      let contact = null;
      try {
        contact = await Contacts.findOne({ phone: from }) ||
          await Contacts.create({
            phone: from,
            name: msg.profile?.name || `WhatsApp ${from.slice(-4)}`,
          });
      } catch (err) {
        logger.warn('[MessagePersistenceWorker] contact_error', { err: err.message });
      }

      // ── 3. LEAD RESOLVE (safe fallback) ───────────────────────────────────
      let lead = null;
      try {
        lead = await resolveLeadByPhone(from, {});
      } catch (err) {
        logger.error('[MessagePersistenceWorker] lead_resolve_failed', { err: err.message });
        lead = { _id: null };
      }

      if (!lead?._id) {
        logger.warn('[MessagePersistenceWorker] lead_missing_fallback_mode', { from });
      }

      // ── 4. SAVE MESSAGE (CRITICAL — throw para retry do BullMQ) ──────────
      let savedMessage;
      try {
        savedMessage = await Message.create({
          waMessageId: wamid,
          from,
          to,
          direction: 'inbound',
          type,
          content: contentToSave,
          mediaUrl,
          mediaId,
          caption,
          status: 'received',
          timestamp,
          contact: contact?._id,
          lead: lead?._id,
          raw: msg,
        });
      } catch (err) {
        logger.error('[MessagePersistenceWorker] message_save_failed — HARD STOP', {
          err: err.message, wamid,
        });
        throw err; // BullMQ retentará com backoff exponencial
      }

      const messageId = savedMessage._id.toString();
      const leadId = lead?._id ? String(lead._id) : null;

      // ── 5. PUBLISH MESSAGE_PERSISTED → lead-interaction + realtime ────────
      publishEvent(EventTypes.MESSAGE_PERSISTED, {
        messageId,
        leadId,
        from,
        to,
        type,
        content: contentToSave,
        timestamp: timestamp.toISOString(),
        wamid,
      }, {
        correlationId,
        aggregateType: 'message',
        aggregateId: messageId,
      }).catch(() => {});

      // ── 6. FIRE-AND-FORGET DOWNSTREAM EVENTS (mesmo comportamento V1) ─────
      publishEvent(EventTypes.CONVERSATION_STATE_UPDATE, {
        leadId,
        from,
        content: contentToSave,
        type,
        direction: 'inbound',
        timestamp: timestamp.toISOString(),
      }, { correlationId }).catch(() => {});

      publishEvent(EventTypes.MESSAGE_RESPONSE_DETECTED, {
        leadId,
        messageId,
        content: contentToSave,
      }, { correlationId }).catch(() => {});

      // CONTEXT_BUILD_REQUESTED é publicado pelo conversationStateWorker
      // APÓS salvar o hot state no Redis — elimina race condition.

      publishEvent(EventTypes.FOLLOWUP_REQUESTED, {
        leadId,
        source: 'inbound',
      }, { correlationId }).catch(() => {});

      publishEvent(EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED, {
        leadId,
        reason: 'lead_respondeu',
      }, { correlationId }).catch(() => {});

      logger.info('[MessagePersistenceWorker] done', { wamid, messageId, leadId, correlationId });

      return { status: 'persisted', messageId, leadId };
    },
    {
      connection: bullMqConnection,
      concurrency: 5,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info(`[MessagePersistenceWorker] ✅ ${job.id} done`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[MessagePersistenceWorker] ❌ ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

export default createMessagePersistenceWorker;
