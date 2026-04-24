/**
 * 🛡️ WhatsApp Pipeline Guard
 *
 * Watchdog crítico: detecta quando mensagens de WhatsApp param de ser processadas.
 * Isso evita a falha silenciosa que ocorreu em 15/04.
 *
 * Regras de alerta:
 * 1. Eventos WHATSAPP_MESSAGE_RECEIVED com status 'pending' há > 2 min → WARNING
 * 2. Eventos WHATSAPP_MESSAGE_RECEIVED com status 'pending' há > 5 min → CRITICAL
 * 3. Workers de WhatsApp não detectados → CRITICAL
 * 4. Fila whatsapp-inbound ou whatsapp-persistence com backlog > 20 → WARNING
 */

import mongoose from 'mongoose';
import { getQueue } from '../queue/queueConfig.js';
import { sendAlert } from '../alerts/alertService.js';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('whatsapp_guard', 'system');

// Configurações
const CHECK_INTERVAL_MS = 60_000; // 1 minuto
const WARNING_THRESHOLD_MIN = 2;
const CRITICAL_THRESHOLD_MIN = 5;
const BACKLOG_WARNING_THRESHOLD = 20;

let isRunning = false;
let lastAlertTimes = {
  pendingWarning: 0,
  pendingCritical: 0,
  workersOff: 0,
  backlog: 0
};

const COOLDOWN_MS = 5 * 60_000; // 5 minutos entre alertas do mesmo tipo

function shouldAlert(type) {
  const now = Date.now();
  if (now - lastAlertTimes[type] < COOLDOWN_MS) return false;
  lastAlertTimes[type] = now;
  return true;
}

// ============================================
// CHECK 1: Eventos pendentes no Event Store
// ============================================
async function checkPendingEvents() {
  const now = new Date();
  const warningDate = new Date(now - WARNING_THRESHOLD_MIN * 60_000);
  const criticalDate = new Date(now - CRITICAL_THRESHOLD_MIN * 60_000);

  const [warningCount, criticalCount, sampleEvents] = await Promise.all([
    mongoose.connection.collection('eventstore').countDocuments({
      eventType: 'WHATSAPP_MESSAGE_RECEIVED',
      status: 'pending',
      createdAt: { $lte: warningDate }
    }),
    mongoose.connection.collection('eventstore').countDocuments({
      eventType: 'WHATSAPP_MESSAGE_RECEIVED',
      status: 'pending',
      createdAt: { $lte: criticalDate }
    }),
    mongoose.connection.collection('eventstore')
      .find({
        eventType: 'WHATSAPP_MESSAGE_RECEIVED',
        status: 'pending',
        createdAt: { $lte: criticalDate }
      })
      .sort({ createdAt: 1 })
      .limit(3)
      .toArray()
  ]);

  if (criticalCount > 0 && shouldAlert('pendingCritical')) {
    logger.error('whatsapp_critical_pending', `${criticalCount} mensagens WhatsApp paradas há +${CRITICAL_THRESHOLD_MIN}min`, {
      count: criticalCount,
      oldest: sampleEvents[0]?.createdAt,
      sampleWamids: sampleEvents.map(e => e.payload?.msg?.id)
    });

    await sendAlert({
      level: 'critical',
      type: 'whatsapp_pipeline_stuck',
      message: `🚨 ${criticalCount} mensagens WhatsApp PARADAS há +${CRITICAL_THRESHOLD_MIN} minutos`,
      details: {
        stuckCount: criticalCount,
        thresholdMinutes: CRITICAL_THRESHOLD_MIN,
        oldestEventAt: sampleEvents[0]?.createdAt,
        sampleWamids: sampleEvents.map(e => e.payload?.msg?.id?.substring(0, 40)),
        action: 'Verificar se crm-worker está ativo e consumindo filas BullMQ'
      }
    });
  } else if (warningCount > 0 && shouldAlert('pendingWarning')) {
    logger.warn('whatsapp_warning_pending', `${warningCount} mensagens WhatsApp atrasadas`, {
      count: warningCount
    });

    await sendAlert({
      level: 'warning',
      type: 'whatsapp_pipeline_slow',
      message: `⚠️ ${warningCount} mensagens WhatsApp atrasadas (>${WARNING_THRESHOLD_MIN}min)`,
      details: {
        stuckCount: warningCount,
        thresholdMinutes: WARNING_THRESHOLD_MIN,
        action: 'Monitorar crm-worker e filas BullMQ'
      }
    });
  }
}

// ============================================
// CHECK 2: Backlog nas filas BullMQ
// ============================================
async function checkQueueBacklog() {
  try {
    const inboundQ = getQueue('whatsapp-inbound');
    const persistenceQ = getQueue('whatsapp-persistence');

    const [inboundCounts, persistenceCounts] = await Promise.all([
      inboundQ.getJobCounts(),
      persistenceQ.getJobCounts()
    ]);

    const inboundWaiting = inboundCounts.waiting || 0;
    const persistenceWaiting = persistenceCounts.waiting || 0;
    const totalBacklog = inboundWaiting + persistenceWaiting;

    if (totalBacklog >= BACKLOG_WARNING_THRESHOLD && shouldAlert('backlog')) {
      logger.warn('whatsapp_backlog', `Backlog WhatsApp: inbound=${inboundWaiting} persistence=${persistenceWaiting}`);

      await sendAlert({
        level: 'warning',
        type: 'whatsapp_queue_backlog',
        message: `📊 Backlog WhatsApp: ${totalBacklog} jobs acumulados`,
        details: {
          inboundWaiting,
          persistenceWaiting,
          threshold: BACKLOG_WARNING_THRESHOLD,
          action: 'Verificar se workers estão consumindo filas'
        }
      });
    }
  } catch (err) {
    logger.error('whatsapp_backlog_check_failed', err.message);
  }
}

// ============================================
// CHECK 3: Workers ativos (indireto via filas)
// ============================================
async function checkWorkersActive() {
  try {
    const inboundQ = getQueue('whatsapp-inbound');
    // Tenta adicionar e remover um job dummy para verificar se a fila responde
    const dummyJob = await inboundQ.add('__healthcheck__', { test: true }, { removeOnComplete: true });
    if (dummyJob?.id) {
      await dummyJob.remove();
    }
  } catch (err) {
    if (shouldAlert('workersOff')) {
      logger.error('whatsapp_workers_unhealthy', 'Fila BullMQ não responde: ' + err.message);
      await sendAlert({
        level: 'critical',
        type: 'whatsapp_workers_down',
        message: '🚨 Workers WhatsApp INACESSÍVEIS — fila BullMQ não responde',
        details: {
          error: err.message,
          action: 'Reiniciar serviço e verificar Redis'
        }
      });
    }
  }
}

// ============================================
// LOOP PRINCIPAL
// ============================================
async function runChecks() {
  if (!isRunning) return;

  try {
    await Promise.all([
      checkPendingEvents(),
      checkQueueBacklog(),
      checkWorkersActive()
    ]);
  } catch (err) {
    logger.error('whatsapp_guard_check_failed', err.message);
  }
}

export function startWhatsAppPipelineGuard() {
  if (isRunning) return;
  isRunning = true;

  console.log('🛡️ [WhatsAppPipelineGuard] Iniciado — checagens a cada 60s');
  logger.info('whatsapp_guard_started', 'Guardião do pipeline WhatsApp ativo');

  // Primeira checagem imediata
  runChecks();

  // Loop contínuo
  setInterval(runChecks, CHECK_INTERVAL_MS);
}

export function stopWhatsAppPipelineGuard() {
  isRunning = false;
  console.log('🛑 [WhatsAppPipelineGuard] Parado');
}
