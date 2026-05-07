import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  instanceId: { type: String, default: 'main', unique: true },
  status: { type: String, default: 'waiting_mongo' },
  ready: { type: Boolean, default: false },
  qrCode: { type: String, default: null },
  error: { type: String, default: null },
  qrTimestamp: { type: Number, default: null },
  updatedAt: { type: Date, default: Date.now },
});

export default mongoose.model('WhatsAppWebState', schema);
