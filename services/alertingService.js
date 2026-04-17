// services/alertingService.js
/**
 * Serviço de Alerting - Billing
 * 
 * Monitora métricas e dispara alertas quando SLOs são violados.
 * Suporta múltiplos canais: log, webhook, Slack (futuro)
 */

import { createContextLogger } from '../utils/logger.js';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';

const logger = createContextLogger('AlertingService');

// Configuração de alertas
const ALERT_CONFIG = {
  // Thresholds
  thresholds: {
    queueSize: {
      warning: 1000,
      critical: 5000
    },
    errorRate: {
      warning: 1,    // 1%
      critical: 5    // 5%
    },
    latency: {
      warning: 5000,  // 5s
      critical: 10000 // 10s
    },
    failedJobs: {
      warning: 10,   // por hora
      critical: 50   // por hora
    }
  },
  
  // Cooldown entre alertas do mesmo tipo (minutos)
  cooldownMinutes: 15,
  
  // Canais
  channels: {
    log: true,      // Sempre ativo
    webhook: process.env.ALERT_WEBHOOK_URL,
    slack: process.env.ALERT_SLACK_WEBHOOK
  }
};

// Estado de alertas (para cooldown)
const alertState = new Map();

// ============================================
// CHECKS
// ============================================

export async function checkAllAlerts() {
  const checks = [
    checkQueueSizes(),
    checkErrorRates(),
    checkFailedJobs(),
    checkConsistency()
  ];
  
  const results = await Promise.all(checks);
  const alerts = results.flat().filter(a => a !== null);
  
  for (const alert of alerts) {
    await dispatchAlert(alert);
  }
  
  return alerts;
}

async function checkQueueSizes() {
  const { getQueue } = await import('../infrastructure/queue/queueConfig.js');
  const queues = [
    { name: 'sync-medical', queue: getQueue('sync-medical') },
    { name: 'insurance-orchestrator', queue: getQueue('insurance-orchestrator') }
  ];
  
  const alerts = [];
  
  for (const { name, queue } of queues) {
    const waiting = await queue.getWaitingCount();
    const failed = await queue.getFailedCount();
    
    if (waiting > ALERT_CONFIG.thresholds.queueSize.critical) {
      alerts.push(createAlert('critical', `Fila ${name} com ${waiting} mensagens pendentes`, {
        queue: name,
        waiting,
        threshold: ALERT_CONFIG.thresholds.queueSize.critical
      }));
    } else if (waiting > ALERT_CONFIG.thresholds.queueSize.warning) {
      alerts.push(createAlert('warning', `Fila ${name} com ${waiting} mensagens pendentes`, {
        queue: name,
        waiting,
        threshold: ALERT_CONFIG.thresholds.queueSize.warning
      }));
    }
    
    if (failed > ALERT_CONFIG.thresholds.failedJobs.critical) {
      alerts.push(createAlert('critical', `Fila ${name} com ${failed} jobs falhos`, {
        queue: name,
        failed,
        threshold: ALERT_CONFIG.thresholds.failedJobs.critical
      }));
    }
  }
  
  return alerts;
}

async function checkErrorRates() {
  // Implementação simplificada - em produção, usar métricas históricas
  const EventStore = (await import('../models/EventStore.js')).default;
  
  const lastHour = new Date(Date.now() - 60 * 60 * 1000);
  
  const [processed, failed] = await Promise.all([
    EventStore.countDocuments({ status: 'processed', processedAt: { $gte: lastHour } }),
    EventStore.countDocuments({ status: 'failed', failedAt: { $gte: lastHour } })
  ]);
  
  const total = processed + failed;
  const errorRate = total > 0 ? (failed / total * 100) : 0;
  
  const alerts = [];
  
  if (errorRate > ALERT_CONFIG.thresholds.errorRate.critical) {
    alerts.push(createAlert('critical', `Taxa de erro crítica: ${errorRate.toFixed(2)}%`, {
      errorRate,
      processed,
      failed
    }));
  } else if (errorRate > ALERT_CONFIG.thresholds.errorRate.warning) {
    alerts.push(createAlert('warning', `Taxa de erro elevada: ${errorRate.toFixed(2)}%`, {
      errorRate,
      processed,
      failed
    }));
  }
  
  return alerts;
}

async function checkFailedJobs() {
  // Similar ao checkErrorRates, mas focado em jobs
  return []; // Implementação simplificada
}

async function checkConsistency() {
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const InsuranceBatchView = (await import('../models/InsuranceBatchView.js')).default;
  
  const [writeCount, viewCount] = await Promise.all([
    InsuranceBatch.countDocuments(),
    InsuranceBatchView.countDocuments()
  ]);
  
  if (writeCount !== viewCount) {
    return [createAlert('critical', `Inconsistência detectada: ${writeCount - viewCount} batches desincronizados`, {
      writeCount,
      viewCount,
      difference: writeCount - viewCount
    })];
  }
  
  return [];
}

// ============================================
// DISPATCH
// ============================================

function createAlert(severity, message, metadata = {}) {
  return {
    id: `${severity}_${message.slice(0, 50).replace(/\s/g, '_')}_${Date.now()}`,
    severity, // 'warning' | 'critical'
    message,
    metadata,
    timestamp: new Date().toISOString()
  };
}

async function dispatchAlert(alert) {
  // Verifica cooldown
  const alertKey = `${alert.severity}_${alert.message}`;
  const lastAlert = alertState.get(alertKey);
  
  if (lastAlert) {
    const minutesSinceLastAlert = (Date.now() - lastAlert) / (1000 * 60);
    if (minutesSinceLastAlert < ALERT_CONFIG.cooldownMinutes) {
      logger.debug('alert_cooldown', 'Alerta em cooldown, ignorando', { alert: alert.message });
      return;
    }
  }
  
  // Registra alerta
  alertState.set(alertKey, Date.now());
  
  // Log (sempre)
  if (ALERT_CONFIG.channels.log) {
    logAlert(alert);
  }
  
  // Webhook (se configurado)
  if (ALERT_CONFIG.channels.webhook) {
    await sendWebhookAlert(alert);
  }
  
  // Slack (se configurado)
  if (ALERT_CONFIG.channels.slack) {
    await sendSlackAlert(alert);
  }
}

function logAlert(alert) {
  const logMethod = alert.severity === 'critical' ? 'error' : 'warn';
  logger[logMethod]('alert_triggered', alert.message, {
    severity: alert.severity,
    ...alert.metadata
  });
}

async function sendWebhookAlert(alert) {
  try {
    const response = await fetch(ALERT_CONFIG.channels.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    logger.error('webhook_alert_failed', 'Falha ao enviar alerta webhook', { error: error.message });
  }
}

async function sendSlackAlert(alert) {
  const color = alert.severity === 'critical' ? '#FF0000' : '#FFA500';
  
  const payload = {
    attachments: [{
      color,
      title: `🚨 Alerta ${alert.severity.toUpperCase()} - Billing`,
      text: alert.message,
      fields: Object.entries(alert.metadata).map(([key, value]) => ({
        title: key,
        value: String(value),
        short: true
      })),
      footer: 'CRM Billing Alerts',
      ts: Math.floor(Date.now() / 1000)
    }]
  };
  
  try {
    const response = await fetch(ALERT_CONFIG.channels.slack, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    logger.error('slack_alert_failed', 'Falha ao enviar alerta Slack', { error: error.message });
  }
}

// ============================================
// CRON JOB
// ============================================

export function startAlertingCron() {
  // Executa a cada 5 minutos
  const interval = 5 * 60 * 1000;
  
  setInterval(async () => {
    try {
      logger.debug('alert_check_start', 'Iniciando verificação de alertas');
      const alerts = await checkAllAlerts();
      logger.info('alert_check_complete', `Verificação completa: ${alerts.length} alertas`, {
        alertsCount: alerts.length
      });
    } catch (error) {
      logger.error('alert_check_error', 'Erro na verificação de alertas', { error: error.message });
    }
  }, interval);
  
  logger.info('alerting_cron_started', `Serviço de alerting iniciado (intervalo: ${interval}ms)`);
}

export default {
  checkAllAlerts,
  startAlertingCron
};
