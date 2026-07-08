/**
 * @fileoverview Modelo único da tabela Outbox.
 *
 * Esquema canônico do pipeline Outbox → BullMQ → Projection Workers.
 * Não deve existir outra collection Outbox no projeto.
 */

import mongoose from 'mongoose';

const outboxSchema = new mongoose.Schema({
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  correlationId: {
    type: String,
    required: true,
    index: true
  },
  eventType: {
    type: String,
    required: true,
    index: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  aggregateType: {
    type: String,
    required: true,
    index: true
  },
  aggregateId: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'published', 'failed'],
    default: 'pending',
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  lastError: {
    type: String
  },
  scheduledAt: {
    type: Date,
    default: Date.now
  },
  publishedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

outboxSchema.index({ status: 1, scheduledAt: 1 });
outboxSchema.index({ aggregateType: 1, aggregateId: 1 });

const OutboxModel = mongoose.models.Outbox || mongoose.model('Outbox', outboxSchema);

export default OutboxModel;
