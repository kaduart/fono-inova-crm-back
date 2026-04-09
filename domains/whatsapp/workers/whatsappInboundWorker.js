/**
 * WhatsApp Inbound Worker
 *
 * Consome: WHATSAPP_MESSAGE_RECEIVED  →  fila: whatsapp-inbound
 */

import { Worker } from 'bullmq';
import { bullMqConnection, redisConnection as redis } from '../../../config/redisConnection.js';
import logger from '../../../utils/logger.js';
import { processInboundMessage } from '../../../controllers/whatsappController.js';

export function createWhatsappInboundWorker() {
  console.log('[WhatsappInboundWorker] 🚀 Criando worker...');
  
  const worker = new Worker(
    'whatsapp-inbound',
    async (job) => {
      console.log(`[WhatsappInboundWorker] 📥 Job recebido: ${job.id}`);
      
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

      try {
        const result = await processInboundMessage(msg, value);
        
        if (result?.duplicate) {
          logger.info('[WhatsappInboundWorker] Mensagem duplicada ignorada', { wamid });
          return { status: 'skipped', reason: 'DUPLICATE', wamid };
        }

        logger.info('[WhatsappInboundWorker] ✅ Mensagem processada com sucesso', { wamid, from });
        return { status: 'processed', wamid };
      } catch (processErr) {
        console.error(`[WhatsappInboundWorker] ❌ Erro ao processar mensagem:`, processErr.message);
        logger.error('[WhatsappInboundWorker] Erro ao processar mensagem:', processErr);
        throw processErr; // Re-throw para BullMQ tentar novamente
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
