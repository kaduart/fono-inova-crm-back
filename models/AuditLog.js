// back/models/AuditLog.js
/**
 * AuditLog
 *
 * Log de auditoria de entidades. Registra quem alterou o quê, quando e qual foi
 * a mudança. Projeto inicial: Appointment writes.
 *
 * - best-effort: falhas nunca devem quebrar o comando que originou o log
 * - TTL de 1 ano (31536000 segundos)
 * - snapshot enxuto dos campos auditáveis
 */

import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    default: null,
  },
  actorRole: {
    type: String,
    default: null,
  },
  action: {
    type: String,
    required: true,
    index: true,
  },
  entityType: {
    type: String,
    required: true,
    index: true,
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  diff: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  source: {
    type: String,
    required: true,
    index: true,
  },
  correlationId: {
    type: String,
    index: true,
    sparse: true,
  },
  severity: {
    type: String,
    enum: ['INFO', 'WARNING', 'CRITICAL'],
    default: 'INFO',
    index: true,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
}, {
  timestamps: true,
});

// TTL: 1 ano
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

export default AuditLog;
