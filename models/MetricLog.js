/**
 * 📊 MetricLog
 *
 * Persistência de métricas estruturadas para dashboards internos.
 * TTL de 30 dias: métricas são voláteis e só importam recentemente.
 */

import mongoose from 'mongoose';

const metricLogSchema = new mongoose.Schema({
  level: { type: String, default: 'metric' },
  service: { type: String, required: true, index: true },
  operation: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now },
  data: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: false,
  capped: false
});

// Índice composto para consultas de dashboard
metricLogSchema.index({ service: 1, operation: 1, timestamp: -1 });

// TTL: remover métricas após 30 dias
metricLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const MetricLog = mongoose.model('MetricLog', metricLogSchema);
export default MetricLog;
