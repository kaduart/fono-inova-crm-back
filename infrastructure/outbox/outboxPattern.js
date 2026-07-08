/**
 * @fileoverview Outbox Pattern — API pública única de publicação de eventos.
 *
 * Regra arquitetural:
 *   Toda alteração de domínio deve salvar o evento no Outbox dentro da mesma
 *   transação MongoDB. O domínio NUNCA publica diretamente em BullMQ.
 *
 * Pipeline canônico:
 *   Transaction
 *     ↓
 *   Outbox.save()
 *     ↓
 *   OutboxDispatcher (poller)
 *     ↓
 *   BullMQ
 *     ↓
 *   Projection Workers
 *     ↓
 *   Read Models
 *
 * @see docs/architecture/EVENT_PROJECTION_INVENTORY.md
 * @see docs/architecture/ARCHITECTURE_RULES.md
 */

import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { getQueue } from '../queue/queueConfig.js';
import Outbox from './OutboxModel.js';
import { eventToQueueMap } from '../events/eventPublisher.js';

/**
 * Salva um evento no Outbox.
 *
 * Deve ser chamado DENTRO de uma transação MongoDB ({ session }) para garantir
 * atomicidade entre o estado de domínio e o evento.
 *
 * @param {Object} event
 * @param {string} event.eventType
 * @param {Object} event.payload
 * @param {string} event.aggregateType
 * @param {string} event.aggregateId
 * @param {string} [event.correlationId]
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<Object>} Entrada do Outbox salva
 */
export async function saveToOutbox(event, session = null) {
  const eventId = event.eventId || uuidv4();
  const outboxEntry = new Outbox({
    eventId,
    correlationId: event.correlationId || uuidv4(),
    eventType: event.eventType,
    payload: event.payload,
    aggregateType: event.aggregateType || 'unknown',
    aggregateId: event.aggregateId ? String(event.aggregateId) : 'unknown',
    status: 'pending',
    createdAt: new Date()
  });

  try {
    await outboxEntry.save({ session });
    console.log(`[Outbox] Evento salvo: ${outboxEntry.eventId} (${outboxEntry.eventType})`);
    return outboxEntry;
  } catch (err) {
    // Idempotência: se o eventId já existe, retorna o registro anterior.
    // Isso protege retries/replays de chamadas determinísticas (ex: paymentStatusService).
    if (err?.code === 11000 && err?.message?.includes('eventId')) {
      console.warn(`[Outbox] Evento duplicado ignorado: ${eventId} (${event.eventType})`);
      const existing = await Outbox.findOne({ eventId }).session(session).lean();
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Publica eventos pendentes do Outbox para as filas BullMQ.
 *
 * Chamado pelo OutboxDispatcher (poller). Não deve ser usado pelo domínio.
 *
 * @param {number} [batchSize=100]
 * @returns {Promise<{processed:number, published:number, failed:number, errors:Array}>}
 */
export async function publishPendingEvents(batchSize = 100) {
  if (mongoose.connection.readyState !== 1) {
    console.log('[OutboxDispatcher] MongoDB não conectado, pulando...');
    return { processed: 0, published: 0, failed: 0, errors: [] };
  }

  const query = {
    status: 'pending',
    scheduledAt: { $lte: new Date() }
  };

  const pendingEvents = await Outbox.find(query)
    .sort({ createdAt: 1 })
    .limit(batchSize)
    .lean();

  const results = { processed: 0, published: 0, failed: 0, errors: [] };

  for (const event of pendingEvents) {
    try {
      const queueNames = getQueueNamesForEvent(event.eventType);

      if (queueNames === null) {
        // Evento desconhecido no mapa: não pode ser publicado, deve ficar visível.
        const errorMsg = `UNKNOWN_EVENT_TYPE: ${event.eventType} não está em eventToQueueMap`;
        console.error(`[OutboxDispatcher] ${errorMsg}`);

        await Outbox.findByIdAndUpdate(event._id, {
          status: 'failed',
          lastError: errorMsg,
          $inc: { attempts: 1 }
        });

        results.failed++;
        results.errors.push({ eventId: event.eventId, error: errorMsg });
        results.processed++;
        continue;
      }

      if (queueNames.length === 0) {
        // Evento mapeado para []: sem fila (ex: TOTALS_RECALCULATED)
        await Outbox.findByIdAndUpdate(event._id, {
          status: 'published',
          publishedAt: new Date()
        });
        results.published++;
        results.processed++;
        continue;
      }

      for (const queueName of queueNames) {
        const queue = getQueue(queueName);

        await queue.add(
          event.eventType,
          {
            eventId: event.eventId,
            eventType: event.eventType,
            correlationId: event.correlationId,
            payload: event.payload,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            outboxId: event._id.toString()
          },
          {
            jobId: `${event.eventId}__${queueName}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 }
          }
        );
      }

      await Outbox.findByIdAndUpdate(event._id, {
        status: 'published',
        publishedAt: new Date()
      });

      results.published++;
    } catch (error) {
      console.error(`[OutboxDispatcher] Falha ao publicar ${event.eventId}:`, error.message);

      await Outbox.findByIdAndUpdate(event._id, {
        status: 'failed',
        lastError: error.message,
        $inc: { attempts: 1 },
        scheduledAt: new Date(Date.now() + Math.pow(2, event.attempts || 0) * 1000)
      });

      results.failed++;
      results.errors.push({ eventId: event.eventId, error: error.message });
    }
    results.processed++;
  }

  return results;
}

/**
 * Inicia o OutboxDispatcher (poller).
 *
 * @param {number} [intervalMs=1000]
 * @returns {Function} Função para parar o dispatcher
 */
export function startOutboxDispatcher(intervalMs = 1000) {
  console.log(`[OutboxDispatcher] Iniciado (intervalo: ${intervalMs}ms)`);

  const intervalId = setInterval(async () => {
    try {
      await publishPendingEvents(100);
    } catch (error) {
      console.error('[OutboxDispatcher] Erro:', error.message);
    }
  }, intervalMs);

  return () => clearInterval(intervalId);
}

/**
 * Limpa eventos publicados antigos.
 *
 * @param {number} [olderThanDays=7]
 * @returns {Promise<number>} Quantidade de eventos removidos
 */
export async function cleanupOutbox(olderThanDays = 7) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const result = await Outbox.deleteMany({
    status: 'published',
    publishedAt: { $lt: cutoffDate }
  });

  console.log(`[OutboxDispatcher] Cleanup: ${result.deletedCount} eventos removidos`);
  return result.deletedCount;
}

/**
 * Retorna a(s) fila(s) BullMQ para um evento.
 *
 * Reutiliza o mapeamento canônico de eventPublisher.js para garantir que um
 * evento publicado pelo Outbox alcance exatamente os mesmos consumidores de um
 * evento publicado pelo dispatcher legado.
 *
 * @param {string} eventType
 * @returns {string[]}
 */
function getQueueNamesForEvent(eventType) {
  const mapped = eventToQueueMap[eventType];

  if (mapped === undefined || mapped === null) {
    // Evento não catalogado: sinaliza explicitamente para o dispatcher falhar.
    return null;
  }

  if (Array.isArray(mapped)) return mapped;
  return [mapped];
}
