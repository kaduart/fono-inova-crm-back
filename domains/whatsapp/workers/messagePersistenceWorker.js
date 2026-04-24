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
import { getIo } from '../../../config/socket.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { extractMessageContent } from '../../../utils/whatsappMediaExtractor.js';
import { normalizeE164BR } from '../../../utils/phone.js';
import { resolveLeadByPhone } from '../../../controllers/leadController.js';
import Contacts from '../../../models/Contacts.js';
import Message from '../../../models/Message.js';
import logger from '../../../utils/logger.js';

export function createMessagePersistenceWorker() {
  console.log('🚀 [MessagePersistenceWorker] REGISTRADO — pronto para consumir');
  const worker = new Worker(
    'whatsapp-persistence',
    async (job) => {
      console.log('📥 [MessagePersistenceWorker] JOB RECEBIDO:', job.id, JSON.stringify(job.data?.payload?.wamid || job.data));
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

        // 🔄 Atualiza lastMessageAt para manter inbox ordenado no frontend
        if (contact) {
          await Contacts.findByIdAndUpdate(contact._id, {
            lastMessageAt: timestamp,
            lastMessagePreview: contentToSave?.slice(0, 120) || '',
          });
          contact.lastMessageAt = timestamp;
          contact.lastMessagePreview = contentToSave?.slice(0, 120) || '';
        }
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

      // ── 4. SAVE MESSAGE (CRITICAL — upsert para não falhar em duplicado) ─
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
        // Duplicate key → mensagem já existe, busca e continua silenciosamente
        if (err.code === 11000 && err.message.includes('waMessageId')) {
          savedMessage = await Message.findOne({ waMessageId: wamid });
          logger.warn('[MessagePersistenceWorker] duplicate_wamid_ignored', { wamid, existingId: savedMessage?._id });
        } else {
          logger.error('[MessagePersistenceWorker] message_save_failed — HARD STOP', {
            err: err.message, wamid,
          });
          throw err; // BullMQ retentará com backoff exponencial
        }
      }

      const messageId = savedMessage._id.toString();
      const leadId = lead?._id ? String(lead._id) : null;
      console.log('💾 [MessagePersistenceWorker] MENSAGEM SALVA:', { messageId, leadId, from, direction: 'inbound' });

      // 🔔 EMITE SOCKET IMEDIATAMENTE (garante atualização da sidebar em tempo real)
      try {
        const io = getIo();
        const contactIdStr = contact?._id ? String(contact._id) : null;
        if (io) {
          io.emit('message:new', {
            id: messageId,
            leadId,
            from,
            to,
            type,
            content: contentToSave,
            text: contentToSave,
            timestamp: timestamp.toISOString(),
            direction: 'inbound',
            contactId: contactIdStr,
            contactName: contact?.name || msg.profile?.name || undefined,
          });
          console.log('📡 [MessagePersistenceWorker] SOCKET EMITIDO message:new para', from);
        } else {
          console.log('⚠️ [MessagePersistenceWorker] getIo() retornou null — socket NÃO emitido');
        }
      } catch (socketErr) {
        // Socket é best-effort — não falha o worker
        logger.warn('[MessagePersistenceWorker] Socket emit falhou (não crítico)', { error: socketErr.message });
      }

      // ── 5. PUBLISH MESSAGE_PERSISTED → lead-interaction + realtime ────────
      publishEvent(EventTypes.MESSAGE_PERSISTED, {
        messageId,
        leadId,
        from,
        to,
        type,
        content: contentToSave,
        text: contentToSave,
        timestamp: timestamp.toISOString(),
        wamid,
        direction: 'inbound',
        source: 'whatsapp',
        contactId: contact?._id ? String(contact._id) : null,
        contactName: contact?.name || msg.profile?.name || null,
      }, {
        correlationId,
        aggregateType: 'system',
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
