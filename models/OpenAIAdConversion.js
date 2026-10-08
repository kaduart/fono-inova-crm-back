import mongoose from 'mongoose';

// _id is the appointment ID (or the activation marker), enforcing deduplication
// even in production where automatic creation of secondary indexes is disabled.
const schema = new mongoose.Schema({
  _id: String,
  eventTime: Date,
  status: { type: String, enum: ['pending', 'sent', 'failed', 'skipped', 'activation'], required: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: () => new Date(0) },
  sentAt: Date,
  reason: String,
}, { timestamps: true });

export default mongoose.models.OpenAIAdConversion || mongoose.model('OpenAIAdConversion', schema);
