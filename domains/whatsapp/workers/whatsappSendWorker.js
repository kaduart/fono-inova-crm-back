/**
 * WhatsApp Send Worker
 *
 * Consome: WHATSAPP_MESSAGE_REQUESTED  →  fila: whatsapp-notification
 * Publica: WHATSAPP_MESSAGE_SENT | WHATSAPP_MESSAGE_FAILED
 *
 * Responsabilidades:
 *   1. Chamar sendTextMessage() → Evolution API
 *   2. Mensagem já é salva no Mongo por registerMessage() dentro do service
 *   3. Emitir socket message:new para atualizar chat em tempo real
 *   4. Publicar evento de resultado (SENT ou FAILED)
 *
 * Idempotência:
 *   - job.id é o idempotencyKey (BullMQ deduplica por jobId no mesmo queue)
 *   - Se message com waMessageId já existir no Mongo → skip silencioso
 *
 * Retry: 3 tentativas com backoff exponencial (2s, 4s, 8s)
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import logger from '../../../utils/logger.js';
import Message from '../../../models/Message.js';
import Contacts from '../../../models/Contacts.js';
import { sendTextMessage } from '../../../services/whatsappService.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { getIo } from '../../../config/socket.js';
import { normalizeE164BR } from '../../../utils/phone.js';

/**
 * Payload esperado em job.data.payload:
 * {
 *   to:          string   — número E.164 do destinatário
 *   text:        string   — texto já formatado
 *   leadId:      string
 *   contactId:   string|null
 *   patientId:   string|null
 *   sentBy:      string   — 'amanda' | 'manual' | etc
 *   source:      string   — origem (ex: 'amanda-reply', 'amanda-resume')
 *   idempotencyKey: string — chave única para evitar reenvio (ex: `send:${leadId}:${hash}`)
 * }
 */
export function createWhatsappSendWorker() {
  console.log('🚀 [WhatsappSendWorker] REGISTRADO — pronto para consumir');
  return new Worker(
    'whatsapp-notification',
    async (job) => {
      const { payload, metadata } = job.data;
      const {
        to,
        text,
        leadId,
        contactId,
        patientId,
        sentBy = 'amanda',
        source = 'whatsapp-send-worker',
        idempotencyKey,
      } = payload;

      const correlationId = metadata?.correlationId || job.id;

      logger.info('[WhatsappSendWorker] Iniciando envio', {
        to,
        leadId,
        sentBy,
        source,
        correlationId,
      });

      // ── Idempotência: se já foi enviado com essa chave, pula ──────────────
      if (idempotencyKey) {
        const existing = await Message.findOne({ 'metadata.idempotencyKey': idempotencyKey }).lean();
        if (existing) {
          logger.info('[WhatsappSendWorker] Mensagem já enviada (idempotência)', {
            idempotencyKey,
            messageId: existing._id,
          });
          return { status: 'skipped', reason: 'ALREADY_SENT', messageId: existing._id };
        }
      }

      // ── 1. Envia via Evolution API + salva no Mongo (dentro do service) ──
      const normalizedTo = normalizeE164BR(to) || to;

      let result;
      try {
        result = await sendTextMessage({
          to: normalizedTo,
          text,
          lead: leadId,
          contactId: contactId || null,
          patientId: patientId || null,
          sentBy,
          metadata: { source, idempotencyKey: idempotencyKey || null },
        });
      } catch (sendErr) {
        logger.error('[WhatsappSendWorker] Falha no sendTextMessage', {
          error: sendErr.message,
          to: normalizedTo,
          leadId,
          correlationId,
        });

        await publishEvent(EventTypes.WHATSAPP_MESSAGE_FAILED, {
          leadId,
          to: normalizedTo,
          error: sendErr.message,
          source,
        }, { correlationId }).catch(() => {});

        throw sendErr; // BullMQ retry
      }

      // ── Guard: envio bloqueado por regra de negócio (ex: manual active) ───
      if (result?.skipped) {
        console.log(`⏸️ [WhatsappSendWorker] SKIP envio bloqueado: reason=${result?.reason}, lead=${leadId}`);
        return { status: 'skipped', reason: result?.reason || 'BUSINESS_RULE' };
      }

      const waMessageId = result?.messages?.[0]?.id || null;

      // ── 2. Busca mensagem salva para emitir socket ────────────────────────
      let savedMsg = null;
      if (waMessageId) {
        // Pequeno delay para garantir que registerMessage() já gravou
        await new Promise(r => setTimeout(r, 200));
        savedMsg = await Message.findOne({ waMessageId }).lean();
      }

      // Fallback: última outbound para esse número (sem waMessageId)
      if (!savedMsg) {
        savedMsg = await Message.findOne({
          to: normalizedTo,
          direction: 'outbound',
          type: 'text',
        }).sort({ timestamp: -1 }).lean();
      }

      // ── 3. Emite socket para atualizar chat em tempo real ─────────────────
      if (savedMsg) {
        try {
          const io = getIo();
          const contact = contactId
            ? { _id: contactId }
            : await Contacts.findOne({ phone: normalizedTo }).lean();

          io.emit('message:new', {
            id:        String(savedMsg._id),
            from:      savedMsg.from,
            to:        savedMsg.to,
            direction: savedMsg.direction,
            type:      savedMsg.type,
            content:   savedMsg.content,
            text:      savedMsg.content,
            status:    savedMsg.status,
            timestamp: savedMsg.timestamp,
            leadId:    String(leadId),
            contactId: String(savedMsg.contact || contact?._id || ''),
            metadata:  savedMsg.metadata || { sentBy },
          });

          logger.info('[WhatsappSendWorker] Socket emitido', {
            messageId: String(savedMsg._id),
            leadId,
          });
        } catch (socketErr) {
          // Socket é best-effort — não falha o job
          logger.warn('[WhatsappSendWorker] Socket emit falhou (não crítico)', {
            error: socketErr.message,
          });
        }
      }

      // ── 4. Publica evento de sucesso ──────────────────────────────────────
      await publishEvent(EventTypes.WHATSAPP_MESSAGE_SENT, {
        leadId,
        to: normalizedTo,
        waMessageId,
        messageId: savedMsg?._id?.toString() || null,
        sentBy,
        source,
      }, { correlationId }).catch(() => {});

      logger.info('[WhatsappSendWorker] Envio concluído', {
        waMessageId,
        leadId,
        correlationId,
      });

      return {
        status: 'sent',
        waMessageId,
        messageId: savedMsg?._id,
      };
    },
    {
      connection: bullMqConnection,
      concurrency: 5,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail:     { count: 200 },
      },
    }
  );
}

export default createWhatsappSendWorker;
