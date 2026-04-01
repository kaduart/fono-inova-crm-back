// routes/metrics.dashboard.js
/**
 * Dashboard de Métricas - Billing & Operações
 * 
 * Endpoints para métricas em tempo real:
 * - Throughput de eventos
 * - Latência de processamento
 * - Taxa de erro
 * - Tamanho de filas
 * - Consistência de dados
 */

import express from 'express';
import { Queue } from 'bullmq';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';
import { createContextLogger } from '../utils/logger.js';
import mongoose from 'mongoose';

const router = express.Router();
const logger = createContextLogger('MetricsDashboard');

// Filas monitoradas
const monitoredQueues = {
  'sync-medical': new Queue('sync-medical', { connection: redisConnection }),
  'insurance-orchestrator': new Queue('insurance-orchestrator', { connection: redisConnection }),
  'patient-projection': new Queue('patient-projection', { connection: redisConnection }),
  'package-projection': new Queue('package-projection', { connection: redisConnection })
};

// ============================================
// GET /api/metrics/dashboard
// Dashboard completo de métricas
// ============================================

router.get('/dashboard', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Coleta métricas em paralelo
    const [
      queueMetrics,
      throughputMetrics,
      consistencyMetrics
    ] = await Promise.all([
      collectQueueMetrics(),
      collectThroughputMetrics(),
      collectConsistencyMetrics()
    ]);

    const dashboard = {
      timestamp: new Date().toISOString(),
      queues: queueMetrics,
      throughput: throughputMetrics,
      consistency: consistencyMetrics,
      health: calculateHealthScore(queueMetrics, throughputMetrics)
    };

    res.json({
      success: true,
      data: dashboard,
      meta: {
        duration: `${Date.now() - startTime}ms`
      }
    });

  } catch (error) {
    logger.error('dashboard_error', 'Erro ao coletar métricas', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Erro ao coletar métricas',
      message: error.message
    });
  }
});

// ============================================
// GET /api/metrics/queues/:name
// Métricas específicas de uma fila
// ============================================

router.get('/queues/:name', async (req, res) => {
  const { name } = req.params;
  
  if (!monitoredQueues[name]) {
    return res.status(404).json({
      success: false,
      error: `Fila ${name} não encontrada`
    });
  }

  try {
    const queue = monitoredQueues[name];
    const metrics = await getQueueMetrics(queue);
    
    res.json({
      success: true,
      data: {
        name,
        ...metrics
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// GET /api/metrics/slo
// Status dos SLOs
// ============================================

router.get('/slo', async (req, res) => {
  try {
    const sloStatus = await checkSLOs();
    
    res.json({
      success: true,
      data: sloStatus
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// COLETOR DE MÉTRICAS
// ============================================

async function collectQueueMetrics() {
  const metrics = {};
  
  for (const [name, queue] of Object.entries(monitoredQueues)) {
    metrics[name] = await getQueueMetrics(queue);
  }
  
  return metrics;
}

async function getQueueMetrics(queue) {
  const [
    waiting,
    active,
    completed,
    failed,
    delayed
  ] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount()
  ]);

  const total = waiting + active + completed + failed + delayed;
  const errorRate = total > 0 ? (failed / total * 100).toFixed(2) : 0;
  
  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total,
    errorRate: `${errorRate}%`,
    status: getQueueStatus(waiting, active, failed)
  };
}

function getQueueStatus(waiting, active, failed) {
  if (failed > 100) return 'critical';
  if (waiting > 1000) return 'warning';
  if (waiting > 5000) return 'critical';
  return 'healthy';
}

async function collectThroughputMetrics() {
  // Simulação - em produção, usar Prometheus/StatsD
  const EventStore = (await import('../models/EventStore.js')).default;
  
  const last5Min = new Date(Date.now() - 5 * 60 * 1000);
  
  const eventsProcessed = await EventStore.countDocuments({
    status: 'processed',
    processedAt: { $gte: last5Min }
  });
  
  const eventsFailed = await EventStore.countDocuments({
    status: 'failed',
    failedAt: { $gte: last5Min }
  });
  
  const throughput = (eventsProcessed / 5).toFixed(2); // por minuto
  const errorRate = eventsProcessed + eventsFailed > 0 
    ? (eventsFailed / (eventsProcessed + eventsFailed) * 100).toFixed(2)
    : 0;

  return {
    eventsPerMinute: parseFloat(throughput),
    errorRate: `${errorRate}%`,
    processedLast5Min: eventsProcessed,
    failedLast5Min: eventsFailed
  };
}

async function collectConsistencyMetrics() {
  const Invoice = (await import('../models/Invoice.js')).default;
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const InsuranceBatchView = (await import('../models/InsuranceBatchView.js')).default;
  
  // Verifica duplicatas
  const duplicates = await Invoice.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    { $group: { _id: '$payment', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: 'total' }
  ]);
  
  // Verifica consistência batch
  const [writeCount, viewCount] = await Promise.all([
    InsuranceBatch.countDocuments(),
    InsuranceBatchView.countDocuments()
  ]);

  return {
    duplicateInvoices: duplicates[0]?.total || 0,
    batchConsistency: {
      writeCount,
      viewCount,
      difference: writeCount - viewCount,
      status: writeCount === viewCount ? 'consistent' : 'inconsistent'
    }
  };
}

function calculateHealthScore(queues, throughput) {
  let score = 100;
  
  // Penaliza filas críticas
  for (const [name, metrics] of Object.entries(queues)) {
    if (metrics.status === 'critical') score -= 30;
    else if (metrics.status === 'warning') score -= 15;
  }
  
  // Penaliza taxa de erro alta
  const errorRate = parseFloat(throughput.errorRate);
  if (errorRate > 5) score -= 25;
  else if (errorRate > 1) score -= 10;
  
  return Math.max(0, score);
}

// ============================================
// SLOs
// ============================================

const SLOs = {
  availability: { target: 99.9, window: '30d' },
  throughput: { target: 10, unit: 'events/min', window: '5m' },
  latency: { target: 5000, unit: 'ms', percentile: 'p99', window: '5m' },
  errorRate: { target: 1, unit: '%', window: '5m' },
  consistency: { target: 100, unit: '%', window: '1h' }
};

async function checkSLOs() {
  const throughput = await collectThroughputMetrics();
  const consistency = await collectConsistencyMetrics();
  
  return {
    slos: SLOs,
    current: {
      throughput: {
        value: throughput.eventsPerMinute,
        target: SLOs.throughput.target,
        status: throughput.eventsPerMinute >= SLOs.throughput.target ? 'met' : 'missed'
      },
      errorRate: {
        value: parseFloat(throughput.errorRate),
        target: SLOs.errorRate.target,
        status: parseFloat(throughput.errorRate) <= SLOs.errorRate.target ? 'met' : 'missed'
      },
      consistency: {
        value: consistency.batchConsistency.difference === 0 ? 100 : 0,
        target: 100,
        status: consistency.batchConsistency.difference === 0 ? 'met' : 'missed'
      }
    }
  };
}

export default router;
