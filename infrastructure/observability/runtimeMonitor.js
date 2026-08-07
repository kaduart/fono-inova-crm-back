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
import { getMemorySnapshot, logMemoryLimits, RSS_LIMIT_INFO } from './memoryStats.js';
import { createContextLogger } from '../../utils/logger.js';
const logger = createContextLogger(null, 'runtime_monitor');

// ============================================
// CONFIGURAÇÃO
// ============================================

const MEM_INTERVAL_MS = 10_000;   // a cada 10s
const QUEUE_INTERVAL_MS = 15_000; // a cada 15s

// ============================================
// HELPERS
// ============================================

const toMB = (v) => Math.round(v / 1024 / 1024);

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

    // Log enxuto — fácil de grep no Render/Logtail.
    // rss = vs cota do container (causa OOM kill); heap = vs heap_size_limit do V8.
    console.log(
      `${icon} [MEMORY] rss=${snap.rssMB}/${snap.rssLimitMB}MB (${snap.rssPercent}%) ` +
      `heap=${snap.heapUsedMB}/${snap.heapLimitMB}MB (${snap.heapPercent}%)`
    );

    // Se crítico, log estruturado para alerta
    if (snap.status === 'critical') {
      logger.error('memory_critical', `RSS >= ${RSS_LIMIT_INFO.critMB}MB ou heap >= 90% do limite do V8`, snap);
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
      heapLimitMB: mem.heapLimitMB,
      heapPercent: mem.heapPercent,
      rssMB: mem.rssMB,
      rssLimitMB: mem.rssLimitMB,
      rssPercent: mem.rssPercent,
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
  // snapshot fresco (não o do último tick) — este endpoint é de debug
  const snap = getMemorySnapshot();

  res.json({
    status: snap.status === 'critical' ? 'degraded' : 'ok',
    node: {
      version: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid
    },
    memory: {
      heapUsedMB: snap.heapUsedMB,
      heapTotalMB: snap.heapTotalMB,
      heapLimitMB: snap.heapLimitMB,
      heapPercent: snap.heapPercent,
      rssMB: snap.rssMB,
      rssLimitMB: snap.rssLimitMB,
      rssPercent: snap.rssPercent,
      externalMB: snap.externalMB,
      arrayBuffersMB: toMB(process.memoryUsage().arrayBuffers || 0),
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

  logMemoryLimits('🔭 [RuntimeMonitor]');
  console.log('🔭 [RuntimeMonitor] Iniciado — logs a cada 10s (mem) / 15s (filas)');
}
