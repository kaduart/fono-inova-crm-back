// routes/package.metrics.js
/**
 * 📊 Métricas de Performance - Package V2
 * 
 * Endpoint para o HeaderAdmin monitorar:
 * - Tempo de resposta
 * - Throughput
 * - Taxa de erro
 * - Comparação com legado
 */

import express from 'express';
import { createContextLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createContextLogger('PackageMetrics');

// Store em memória (em produção usar Redis/DB)
const metricsStore = {
  requests: [],
  maxSize: 1000,
  
  add(metric) {
    this.requests.push(metric);
    if (this.requests.length > this.maxSize) {
      this.requests.shift();
    }
  },
  
  getStats(timeWindow = 3600000) { // última hora
    const cutoff = Date.now() - timeWindow;
    const recent = this.requests.filter(r => r.timestamp > cutoff);
    
    if (recent.length === 0) return null;
    
    const durations = recent.map(r => r.duration);
    const txDurations = recent.map(r => r.transactionDuration);
    
    return {
      count: recent.length,
      totalDuration: {
        avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
        min: Math.min(...durations),
        max: Math.max(...durations),
        p95: Math.round(durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)]),
        p99: Math.round(durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.99)])
      },
      transactionDuration: {
        avg: Math.round(txDurations.reduce((a, b) => a + b, 0) / txDurations.length),
        min: Math.min(...txDurations),
        max: Math.max(...txDurations)
      },
      operations: {
        avg: recent.reduce((a, r) => a + r.operations, 0) / recent.length
      },
      errors: recent.filter(r => r.error).length,
      successRate: ((recent.length - recent.filter(r => r.error).length) / recent.length * 100).toFixed(2)
    };
  }
};

/**
 * 🎯 Registrar métrica (chamado pelo controller)
 */
export function recordPackageMetric(metric) {
  metricsStore.add({
    timestamp: Date.now(),
    ...metric
  });
}

/**
 * 📊 GET /api/metrics/packages
 * Dashboard de métricas para HeaderAdmin
 */
router.get('/', async (req, res) => {
  try {
    const timeWindow = parseInt(req.query.window) || 3600000; // 1h default
    const stats = metricsStore.getStats(timeWindow);
    
    // Benchmarks para comparação
    const benchmarks = {
      legacy: {
        avgDuration: 450,    // ms - estimado legado
        avgTxDuration: 280,  // ms
        avgQueries: 25       // N+1
      },
      v2: {
        avgDuration: stats?.totalDuration?.avg || 0,
        avgTxDuration: stats?.transactionDuration?.avg || 0,
        avgQueries: stats?.operations?.avg || 0
      }
    };
    
    // Calcular melhorias
    const improvements = {
      totalTime: benchmarks.legacy.avgDuration > 0 
        ? ((benchmarks.legacy.avgDuration - benchmarks.v2.avgDuration) / benchmarks.legacy.avgDuration * 100).toFixed(1)
        : 0,
      transactionTime: benchmarks.legacy.avgTxDuration > 0
        ? ((benchmarks.legacy.avgTxDuration - benchmarks.v2.avgTxDuration) / benchmarks.legacy.avgTxDuration * 100).toFixed(1)
        : 0,
      queries: benchmarks.legacy.avgQueries > 0
        ? ((benchmarks.legacy.avgQueries - benchmarks.v2.avgQueries) / benchmarks.legacy.avgQueries * 100).toFixed(1)
        : 0
    };
    
    res.json({
      success: true,
      timeWindow: `${timeWindow / 60000} minutos`,
      stats: stats || { message: 'Sem dados no período' },
      benchmarks,
      improvements: {
        totalTime: `${improvements.totalTime}%`,
        transactionTime: `${improvements.transactionTime}%`,
        queries: `${improvements.queries}%`,
        summary: improvements.totalTime > 30 
          ? '🔥 EXCELENTE: Melhoria significativa'
          : improvements.totalTime > 10
            ? '✅ BOM: Melhoria moderada'
            : improvements.totalTime > 0
              ? '⚠️ LEVE: Pequena melhoria'
              : '❌ ATENÇÃO: Sem melhoria ou piora'
      },
      recommendations: [
        stats?.totalDuration?.avg > 500 ? '⚠️ Tempo médio alto - investigar' : null,
        stats?.totalDuration?.p95 > 1000 ? '⚠️ P95 acima de 1s - revisar índices' : null,
        parseFloat(improvements.totalTime) < 0 ? '❌ Performance pior que legado - revisar' : null
      ].filter(Boolean)
    });
    
  } catch (error) {
    logger.error('Error getting metrics', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 📈 GET /api/metrics/packages/realtime
 * Dados em tempo real (últimos 10 requests)
 */
router.get('/realtime', (req, res) => {
  const recent = metricsStore.requests.slice(-10);
  res.json({
    success: true,
    recentRequests: recent,
    currentThroughput: recent.length > 0 
      ? (recent.length / ((Date.now() - recent[0].timestamp) / 1000)).toFixed(2)
      : 0
  });
});

/**
 * 🧪 POST /api/metrics/packages/record
 * Endpoint para testes - registra métrica manual
 */
router.post('/record', (req, res) => {
  const { duration, transactionDuration, operations, error } = req.body;
  recordPackageMetric({
    duration: duration || 0,
    transactionDuration: transactionDuration || 0,
    operations: operations || 0,
    error: error || false
  });
  res.json({ success: true, message: 'Métrica registrada' });
});

/**
 * 📊 Função para integração com Health Check
 * Retorna métricas resumidas para o /api/health/full
 */
export async function getPackageMetricsForHealth() {
  try {
    const stats = metricsStore.getStats(3600000); // última hora
    
    if (!stats || stats.count === 0) {
      return {
        status: 'no_data',
        message: 'Sem dados de métricas ainda'
      };
    }
    
    return {
      status: 'ok',
      summary: {
        totalRequests: stats.count,
        avgResponseTime: stats.totalDuration.avg,
        avgTransactionTime: stats.transactionDuration.avg,
        successRate: parseFloat(stats.successRate),
        grade: stats.totalDuration.avg < 200 ? 'EXCELLENT' : 
               stats.totalDuration.avg < 500 ? 'GOOD' : 
               stats.totalDuration.avg < 1000 ? 'FAIR' : 'SLOW'
      },
      // Benchmarks comparativos
      vsLegacy: {
        improvement: ((450 - stats.totalDuration.avg) / 450 * 100).toFixed(1) + '%',
        faster: stats.totalDuration.avg < 450
      }
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message
    };
  }
}

export default router;
