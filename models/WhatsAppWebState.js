import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  instanceId: { type: String, default: 'main', unique: true },
  status: { type: String, default: 'waiting_mongo' },
  ready: { type: Boolean, default: false },
  authenticated: { type: Boolean, default: false },
  qrCode: { type: String, default: null },
  error: { type: String, default: null },
  qrTimestamp: { type: Number, default: null },
  pid: { type: Number, default: null },
  uptime: { type: Number, default: null },
  sessionPersisted: { type: Boolean, default: false },
  sessionFiles: { type: Number, default: 0 },
  lastDisconnectReason: { type: String, default: null },
  lastAuthenticatedAt: { type: Date, default: null },
  qrCount: { type: Number, default: 0 },
  initAttempts: { type: Number, default: 0 },
  reconnectSignal: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now },
});

export default mongoose.model('WhatsAppWebState', schema);
