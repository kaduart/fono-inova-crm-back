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
import { getQueue } from '../infrastructure/queue/queueConfig.js';
import { createContextLogger } from '../utils/logger.js';
import mongoose from 'mongoose';
import { getSnapshot } from '../orchestrators/decision/decisionMetricsService.js';

const router = express.Router();
const logger = createContextLogger('MetricsDashboard');

// Filas monitoradas - EXPANDIDO: inclui appointment e DLQ
// Usa getQueue para reaproveitar instâncias e evitar multiplicação de conexões
const monitoredQueueNames = [
  'sync-medical',
  'insurance-orchestrator',
  'patient-projection',
  'package-projection',
  'appointment-processing',
  'create-appointment-processing',
  'payment-processing',
  'cancel-orchestrator',
  'complete-orchestrator',
  'clinical-orchestrator',
  'dlq',
  'dlq-critical'
];

const monitoredQueues = Object.fromEntries(
  monitoredQueueNames.map(name => [name, getQueue(name)])
);

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
  const EventStore = (await import('../models/EventStore.js')).default;
  
  const last5Min = new Date(Date.now() - 5 * 60 * 1000);
  const last1Hour = new Date(Date.now() - 60 * 60 * 1000);
  
  // Métricas gerais
  const [eventsProcessed, eventsFailed, eventsPending] = await Promise.all([
    EventStore.countDocuments({
      status: 'processed',
      processedAt: { $gte: last5Min }
    }),
    EventStore.countDocuments({
      status: 'failed',
      failedAt: { $gte: last5Min }
    }),
    EventStore.countDocuments({
      status: { $in: ['pending', 'processing'] }
    })
  ]);
  
  // Métricas por tipo de evento (appointment-focused)
  const appointmentEvents = await EventStore.aggregate([
    {
      $match: {
        eventType: { $regex: /APPOINTMENT/ },
        createdAt: { $gte: last1Hour }
      }
    },
    {
      $group: {
        _id: '$eventType',
        total: { $sum: 1 },
        processed: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }
      }
    },
    { $sort: { total: -1 } }
  ]);
  
  // DLQ metrics
  const dlqMetrics = await collectDLQMetrics();
  
  const throughput = (eventsProcessed / 5).toFixed(2);
  const errorRate = eventsProcessed + eventsFailed > 0 
    ? (eventsFailed / (eventsProcessed + eventsFailed) * 100).toFixed(2)
    : 0;

  return {
    eventsPerMinute: parseFloat(throughput),
    errorRate: `${errorRate}%`,
    processedLast5Min: eventsProcessed,
    failedLast5Min: eventsFailed,
    pendingEvents: eventsPending,
    appointmentEvents: appointmentEvents.reduce((acc, item) => {
      acc[item._id] = { total: item.total, processed: item.processed, failed: item.failed };
      return acc;
    }, {}),
    dlq: dlqMetrics
  };
}

// ============================================
// DLQ METRICS (novo)
// ============================================

async function collectDLQMetrics() {
  const dlqQueue = monitoredQueues['dlq'];
  const dlqCriticalQueue = monitoredQueues['dlq-critical'];
  
  if (!dlqQueue) return { error: 'DLQ not configured' };
  
  try {
    const [
      waiting,
      failed,
      criticalWaiting
    ] = await Promise.all([
      dlqQueue.getWaitingCount(),
      dlqQueue.getFailedCount(),
      dlqCriticalQueue ? dlqCriticalQueue.getWaitingCount() : Promise.resolve(0)
    ]);
    
    // Busca jobs recentes na DLQ para análise
    const recentJobs = await dlqQueue.getJobs(['waiting'], 0, 10);
    const recentErrors = recentJobs.map(job => ({
      id: job.id,
      name: job.name,
      failedReason: job.failedReason || 'unknown',
      timestamp: job.timestamp
    }));
    
    const total = waiting + failed;
    const status = total > 50 ? 'critical' : total > 10 ? 'warning' : 'healthy';
    
    return {
      total,
      waiting,
      failed,
      criticalWaiting,
      recentErrors,
      status,
      alert: total > 0 ? `${total} jobs em DLQ precisam de atenção` : null
    };
  } catch (error) {
    logger.error('dlq_metrics_error', 'Erro ao coletar DLQ metrics', { error: error.message });
    return { error: error.message };
  }
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
// SLOs - EXPANDIDO
// ============================================

const SLOs = {
  availability: { target: 99.9, window: '30d' },
  throughput: { target: 10, unit: 'events/min', window: '5m' },
  latency: { target: 5000, unit: 'ms', percentile: 'p99', window: '5m' },
  errorRate: { target: 1, unit: '%', window: '5m' },
  consistency: { target: 100, unit: '%', window: '1h' },
  dlqSize: { target: 0, unit: 'jobs', window: '5m' }, // Novo: DLQ deve estar vazia
  appointmentSuccess: { target: 95, unit: '%', window: '1h' } // Novo: taxa de sucesso de agendamentos
};

async function checkSLOs() {
  const throughput = await collectThroughputMetrics();
  const consistency = await collectConsistencyMetrics();
  
  // Calcular taxa de sucesso de agendamentos
  const appointmentStats = throughput.appointmentEvents;
  const totalAppointments = Object.values(appointmentStats).reduce((sum, evt) => sum + evt.total, 0);
  const failedAppointments = Object.values(appointmentStats).reduce((sum, evt) => sum + evt.failed, 0);
  const appointmentSuccessRate = totalAppointments > 0 
    ? ((totalAppointments - failedAppointments) / totalAppointments * 100).toFixed(2)
    : 100;
  
  // DLQ status
  const dlqSize = throughput.dlq?.total || 0;
  
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
      },
      appointmentSuccess: {
        value: parseFloat(appointmentSuccessRate),
        target: SLOs.appointmentSuccess.target,
        status: parseFloat(appointmentSuccessRate) >= SLOs.appointmentSuccess.target ? 'met' : 'missed'
      },
      dlqSize: {
        value: dlqSize,
        target: 0,
        status: dlqSize === 0 ? 'met' : 'missed',
        alert: dlqSize > 0 ? `${dlqSize} jobs na DLQ` : null
      }
    }
  };
}

// ============================================
// GET /api/metrics/decision
// Dashboard de decisões do AmandaOrchestrator
// ============================================

router.get('/decision', async (req, res) => {
  try {
    const windowMinutes = req.query.window ? parseInt(req.query.window, 10) : undefined;
    const last          = req.query.last   ? parseInt(req.query.last, 10)   : undefined;

    const snapshot = await getSnapshot({ windowMinutes, last });

    res.json({
      success: true,
      data: snapshot,
      meta: {
        generatedAt: new Date().toISOString(),
        note: snapshot.source === 'mongodb'
          ? 'Dados persistidos no MongoDB (sobrevive a restarts)'
          : 'Buffer em memória — sem dados persistidos ainda'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
