/**
 * Log estruturado para observabilidade de serviços.
 *
 * Regras:
 *   - Emite JSON em stdout para ser coletado por agentes de log.
 *   - Persiste em MongoDB (MetricLog) com TTL de 30 dias para dashboards internos.
 *   - Campos mínimos: service, operation, timestamp.
 *   - Não lança exceções: falhas de log não devem quebrar requisições.
 */

function persistMetric(service, operation, metric) {
  // Persistência assíncrona em background (não bloqueia)
  if (typeof process !== 'undefined' && process.env?.DISABLE_METRIC_LOG === 'true') return;

  Promise.resolve().then(async () => {
    try {
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection?.readyState !== 1) return;
      const { default: MetricLog } = await import('../models/MetricLog.js');
      await MetricLog.create({
        service,
        operation,
        timestamp: new Date(),
        data: metric
      });
    } catch (persistErr) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[logMetric] Persistência ignorada:', persistErr.message);
      }
    }
  });
}

export function logMetric(service, operation, metric) {
  try {
    const payload = {
      level: 'metric',
      service,
      operation,
      timestamp: new Date().toISOString(),
      ...metric
    };

    console.log(JSON.stringify(payload));
    persistMetric(service, operation, metric);
  } catch (err) {
    console.error('[logMetric] Falha ao emitir métrica:', err.message);
  }
}
