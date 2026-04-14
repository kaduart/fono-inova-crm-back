/**
 * DecisionMetric — Persistência das decisões do Amanda AI
 *
 * TTL automático: 30 dias (índice MongoDB).
 * Grava async (fire-and-forget) sem bloquear o fluxo do orchestrator.
 */

import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

const DecisionMetricSchema = new Schema({
  ts:          { type: Date,    required: true, index: true },
  action:      { type: String,  required: true, enum: ['RULE', 'HYBRID', 'AI', 'unknown'] },
  domain:      { type: String,  default: null },
  confidence:  { type: Number,  default: null },
  flags:       { type: [String], default: [] },
  latencyMs:   { type: Number,  default: null },
  orchestrator:{ type: String,  default: null },
}, {
  timestamps: false,
  versionKey: false,
});

// TTL: remove automaticamente após 30 dias
DecisionMetricSchema.index({ ts: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export default models.DecisionMetric || model('DecisionMetric', DecisionMetricSchema);
