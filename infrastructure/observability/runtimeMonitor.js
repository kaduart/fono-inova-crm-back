// infrastructure/observability/runtimeMonitor.js
/**
 * Monitor de produção em tempo real
 *
 * Expõe:
 *   - Métricas de memória (heap, rss, external)
 *   - Contagem de jobs por fila BullMQ
 *   - Uptime e timestamp
 *
 * Sem dependências externas. Leve. Seguro.
 */

import { getQueue } from '../queue/queueConfig.js';
import { createContextLogger } from '../../utils/logger.js';
const logger = createContextLogger(null, 'runtime_monitor');

// ============================================
// CONFIGURAÇÃO
// ============================================

const MEM_INTERVAL_MS = 10_000;   // a cada 10s
const QUEUE_INTERVAL_MS = 15_000; // a cada 15s
const RSS_THRESHOLD_WARN_MB = 1024; // 1GB
const RSS_THRESHOLD_CRIT_MB = 2048; // 2GB

// ============================================
// HELPERS
// ============================================

const toMB = (v) => Math.round(v / 1024 / 1024);

function getMemorySnapshot() {
  const mem = process.memoryUsage();
  const heapPercent = mem.heapUsed / mem.heapTotal;
  const rssMB = toMB(mem.rss);

  return {
    heapUsedMB: toMB(mem.heapUsed),
    heapTotalMB: toMB(mem.heapTotal),
    heapPercent: parseFloat((heapPercent * 100).toFixed(1)),
    rssMB,
    externalMB: toMB(mem.external),
    status:
      rssMB >= RSS_THRESHOLD_CRIT_MB ? 'critical' :
      rssMB >= RSS_THRESHOLD_WARN_MB ? 'warning' : 'healthy'
  };
}

// ============================================
// MONITOR DE MEMÓRIA
// ============================================

let lastMemory = null;

function startMemoryMonitor() {
  setInterval(() => {
    const snap = getMemorySnapshot();
    lastMemory = snap;

    const icon = snap.status === 'critical' ? '🔴' :
                 snap.status === 'warning'  ? '🟡' : '🟢';

    // Log enxuto — fácil de grep no Render/Logtail
    console.log(`${icon} [MEMORY] rss=${snap.rssMB}MB heap=${snap.heapUsedMB}/${snap.heapTotalMB}MB (${snap.heapPercent}%)`);

    // Se crítico, log estruturado para alerta
    if (snap.status === 'critical') {
      logger.error('memory_critical', 'RSS acima de 2GB', snap);
    }
  }, MEM_INTERVAL_MS);
}

// ============================================
// MONITOR DE FILAS
// ============================================

// Lista de filas que queremos monitorar
const MONITORED_QUEUES = [
  'package-projection',
  'package-validation',
  'patient-projection',
  'complete-orchestrator',
  'cancel-orchestrator',
  'totals-calculation',
  'daily-closing',
  'whatsapp-inbound',
  'whatsapp-persistence',
  'whatsapp-lead-interaction',
  'whatsapp-realtime',
  'whatsapp-chat-projection',
  'whatsapp-auto-reply',
];

let lastQueueStats = {};

async function startQueueMonitor() {
  setInterval(async () => {
    try {
      const stats = {};
      for (const name of MONITORED_QUEUES) {
        const q = getQueue(name);
        const counts = await q.getJobCounts();
        stats[name] = counts;
      }
      lastQueueStats = stats;

      // Só loga se houver algo acumulando (evita spam)
      const hasBacklog = Object.values(stats).some(c =>
        (c.waiting || 0) > 10 || (c.active || 0) > 5 || (c.failed || 0) > 0
      );

      if (hasBacklog) {
        console.log('📊 [QUEUE] backlog detectado', stats);
      } else {
        // Log resumido a cada ciclo
        const totalWaiting = Object.values(stats).reduce((s, c) => s + (c.waiting || 0), 0);
        console.log(`📊 [QUEUE] totalWaiting=${totalWaiting} filas=${MONITORED_QUEUES.length}`);
      }
    } catch (err) {
      logger.error('queue_monitor_failed', err.message);
    }
  }, QUEUE_INTERVAL_MS);
}

// ============================================
// HEALTH ENDPOINT HANDLER
// ============================================

export function healthEndpoint(req, res) {
  const mem = lastMemory || getMemorySnapshot();

  res.status(mem.status === 'critical' ? 503 : 200).json({
    status: mem.status === 'critical' ? 'degraded' : 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      heapUsedMB: mem.heapUsedMB,
      heapTotalMB: mem.heapTotalMB,
      heapPercent: mem.heapPercent,
      rssMB: mem.rssMB,
      status: mem.status
    },
    queues: lastQueueStats || {},
    timestamp: new Date().toISOString()
  });
}

// ============================================
// HEALTH FULL (debug/detailed)
// ============================================

export function healthFullEndpoint(req, res) {
  const mem = process.memoryUsage();
  const snap = lastMemory || getMemorySnapshot();

  res.json({
    status: snap.status === 'critical' ? 'degraded' : 'ok',
    node: {
      version: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid
    },
    memory: {
      heapUsedMB: toMB(mem.heapUsed),
      heapTotalMB: toMB(mem.heapTotal),
      heapPercent: snap.heapPercent,
      rssMB: toMB(mem.rss),
      externalMB: toMB(mem.external),
      arrayBuffersMB: toMB(mem.arrayBuffers || 0),
      status: snap.status
    },
    queues: lastQueueStats || {},
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
}

// ============================================
// INIT
// ============================================

export function startRuntimeMonitor() {
  startMemoryMonitor();
  startQueueMonitor().catch(err =>
    logger.error('queue_monitor_init_failed', err.message)
  );

  console.log('🔭 [RuntimeMonitor] Iniciado — logs a cada 10s (mem) / 15s (filas)');
}
