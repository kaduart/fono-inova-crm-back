/**
 * WhatsApp Inbound Worker
 *
 * Consome: WHATSAPP_MESSAGE_RECEIVED  →  fila: whatsapp-inbound
 */

import { Worker } from 'bullmq';
import { bullMqConnection, redisConnection as redis } from '../../../config/redisConnection.js';
import logger from '../../../utils/logger.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { markEventProcessed, markEventFailed } from '../../../infrastructure/events/eventStoreService.js';

export function createWhatsappInboundWorker() {
  console.log('[WhatsappInboundWorker] 🚀 Criando worker...');
  
  const worker = new Worker(
    'whatsapp-inbound',
    async (job) => {
      console.log(`[WhatsappInboundWorker] 📥 Job recebido: ${job.id}`);
      
      // Ignora jobs de healthcheck que não têm payload válido
      if (job.name === '__healthcheck__' || !job.data?.payload) {
        console.log(`[WhatsappInboundWorker] ⏭️ Job ${job.id} ignorado (healthcheck ou sem payload)`);
        return { status: 'ignored', reason: 'healthcheck_or_no_payload' };
      }
      
      const { payload, metadata } = job.data;
      let { msg, value } = payload;

      const wamid    = msg?.id || job.id;
      const from     = msg?.from || 'unknown';
      const correlationId = metadata?.correlationId || job.id;

      logger.info('[WhatsappInboundWorker] Processando mensagem inbound', {
        wamid,
        from,
        correlationId,
      });

      // Processa debounce se a mensagem veio do webhook com delay
      if (payload._isDebounced && payload._debounceKey) {
        try {
          const buffer = await redis?.get(payload._debounceKey);
          
          if (buffer) {
            const data = JSON.parse(buffer);
            
            if (data.messages && data.messages.length > 1) {
              const combinedText = data.messages.join(' ');
              if (!msg.text) {
                msg.text = { body: combinedText };
              } else {
                msg.text.body = combinedText;
              }
              logger.info('[WhatsappInboundWorker] Mensagens combinadas', {
                wamid,
                count: data.messages.length,
              });
            }
            
            await redis?.del(payload._debounceKey);
            logger.info('[WhatsappInboundWorker] Buffer limpo', { debounceKey: payload._debounceKey });
          }
        } catch (debounceErr) {
          logger.warn('[WhatsappInboundWorker] Erro ao processar debounce:', debounceErr.message);
        }
      }

      // Publica para messagePersistenceWorker (V2 — sem chamar processInboundMessage)
      try {
        await publishEvent(
          EventTypes.WHATSAPP_MESSAGE_PREPROCESSED,
          {
            msg,
            value,
            combinedText: msg.text?.body || '',
          },
          {
            correlationId,
            aggregateType: 'system',
            aggregateId: wamid,
          }
        );

        // Marca evento original como processado no EventStore
        if (job.data?.eventId) {
          await markEventProcessed(job.data.eventId, 'WhatsappInboundWorker').catch(err => {
            logger.warn('[WhatsappInboundWorker] Falha ao marcar evento como processado:', err.message);
          });
        }

        logger.info('[WhatsappInboundWorker] ✅ Publicado WHATSAPP_MESSAGE_PREPROCESSED', { wamid, from });
        return { status: 'dispatched', wamid };
      } catch (publishErr) {
        console.error(`[WhatsappInboundWorker] ❌ Erro ao publicar evento:`, publishErr.message);
        logger.error('[WhatsappInboundWorker] Erro ao publicar WHATSAPP_MESSAGE_PREPROCESSED:', publishErr);
        
        // Marca evento como falhou no EventStore
        if (job.data?.eventId) {
          await markEventFailed(job.data.eventId, publishErr).catch(err => {
            logger.warn('[WhatsappInboundWorker] Falha ao marcar evento como falhou:', err.message);
          });
        }
        
        throw publishErr; // Re-throw para BullMQ tentar novamente
      }
    },
    {
      connection: bullMqConnection,
      concurrency: 3,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail:     { count: 500 },
      },
    }
  );

  // Eventos do worker para debug
  worker.on('completed', (job) => {
    console.log(`[WhatsappInboundWorker] ✅ Job completado: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[WhatsappInboundWorker] ❌ Job falhou: ${job?.id}, erro: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error(`[WhatsappInboundWorker] ❌ Erro no worker:`, err.message);
  });

  worker.on('ready', () => {
    console.log('[WhatsappInboundWorker] 🟢 Worker pronto para processar jobs');
  });

  console.log('[WhatsappInboundWorker] ✅ Worker criado e configurado');
  return worker;
}

export default createWhatsappInboundWorker;
