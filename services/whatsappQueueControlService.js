// back/services/whatsappQueueControlService.js
/**
 * Kill switch operacional da fila whatsapp-send.
 *
 * Nasceu do incidente de 2026-07-16: um crash em sendMessage() marcava jobs
 * já entregues como failed, e o retry automático da fila (attempts:8,
 * backoff exponencial) reenviava a mesma mensagem várias vezes pro mesmo
 * paciente. Ver memory: project_whatsapp_send_infinite_retry_incident.
 *
 * queue.pause() é global (sem argumento) — nenhum worker em nenhuma
 * instância consome novos jobs enquanto pausada. Jobs `active` no momento
 * da pausa terminam normalmente.
 */

import mongoose from 'mongoose';
import { whatsappSendQueue } from '../config/bullConfig.js';
import AuditLog from '../models/AuditLog.js';

const QUEUE_NAME = 'whatsapp-send';

async function recordQueueAudit(action, user, metadata) {
  try {
    await new AuditLog({
      userId: user?.id || null,
      actorRole: user?.role || 'SYSTEM',
      action,
      entityType: 'WhatsAppQueue',
      entityId: new mongoose.Types.ObjectId(), // fila não é documento Mongo; ref real vai em metadata
      source: 'admin_queue_control',
      severity: action === 'whatsapp_queue_cleared' ? 'CRITICAL' : 'WARNING',
      metadata: { queueName: QUEUE_NAME, ...metadata },
    }).save();
  } catch (err) {
    console.error('[WhatsAppQueueControl] Falha ao gravar auditoria:', err.message);
  }
}

export async function getQueueStatus() {
  const [waiting, delayed, active, failed, completed, isPaused] = await Promise.all([
    whatsappSendQueue.getWaitingCount(),
    whatsappSendQueue.getDelayedCount(),
    whatsappSendQueue.getActiveCount(),
    whatsappSendQueue.getFailedCount(),
    whatsappSendQueue.getCompletedCount(),
    whatsappSendQueue.isPaused(),
  ]);

  const recentFailed = await whatsappSendQueue.getFailed(0, 5);
  const lastFailed = recentFailed[0]
    ? { phone: recentFailed[0].data?.phone, reason: recentFailed[0].failedReason, attempts: recentFailed[0].attemptsMade }
    : null;

  return { queueName: QUEUE_NAME, isPaused, counts: { waiting, delayed, active, failed, completed }, lastFailed };
}

export async function pauseQueue(user) {
  await whatsappSendQueue.pause();
  await recordQueueAudit('whatsapp_queue_paused', user, {});
  return getQueueStatus();
}

export async function resumeQueue(user) {
  await whatsappSendQueue.resume();
  await recordQueueAudit('whatsapp_queue_resumed', user, {});
  return getQueueStatus();
}

// Remove jobs presos em retry: delayed (aguardando próximo backoff) e
// waiting que já tentaram ao menos uma vez (backoff já venceu, prontos
// pra reprocessar). Jobs waiting "de primeira viagem" (attemptsMade=0)
// não são tocados — são envios legítimos ainda não tentados.
export async function clearStuckRetries(user) {
  const [delayed, waiting] = await Promise.all([
    whatsappSendQueue.getDelayed(0, 1000),
    whatsappSendQueue.getWaiting(0, 1000),
  ]);

  const stuck = [...delayed, ...waiting.filter((j) => (j.attemptsMade || 0) > 0)];

  const removed = [];
  for (const job of stuck) {
    try {
      await job.remove();
      removed.push({ id: job.id, phone: job.data?.phone, attemptsMade: job.attemptsMade });
    } catch (err) {
      console.error(`[WhatsAppQueueControl] Falha ao remover job ${job.id}:`, err.message);
    }
  }

  await recordQueueAudit('whatsapp_queue_cleared', user, { removedCount: removed.length, removed });

  return { removedCount: removed.length, removed, status: await getQueueStatus() };
}

export async function getRecentAuditLog(limit = 20) {
  return AuditLog.find({ entityType: 'WhatsAppQueue' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export default { getQueueStatus, pauseQueue, resumeQueue, clearStuckRetries, getRecentAuditLog };
