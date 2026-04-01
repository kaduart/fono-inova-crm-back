// models/Outbox.js
import mongoose from 'mongoose';

const outboxSchema = new mongoose.Schema({
  eventType: {
    type: String,
    required: true,
    index: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  options: {
    correlationId: String,
    idempotencyKey: String,
    delay: Number,
    priority: Number
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'published', 'failed'],
    default: 'pending',
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  error: String,
  publishedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Index para query eficiente
outboxSchema.index({ status: 1, createdAt: 1 });

export default mongoose.models.Outbox || mongoose.model('Outbox', outboxSchema);
