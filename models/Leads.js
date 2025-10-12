import mongoose from 'mongoose';

const interactionSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  channel: { type: String, enum: ['whatsapp', 'telefone', 'email', 'manual'], default: 'manual' },
  direction: { type: String, enum: ['inbound', 'outbound'], default: 'outbound' },
  message: String,
  note: String,
  status: { type: String, enum: ['sent', 'received', 'failed', 'read'], default: 'sent' }
});

const leadSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contact: {
    email: String,
    phone: { type: String, index: true }
  },
  origin: { type: String, enum: ['WhatsApp', 'Site', 'Indicação', 'Outro'], default: 'Outro' },
  status: { type: String, enum: ['novo', 'atendimento', 'convertido', 'perdido'], default: 'novo', index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  interactions: [interactionSchema],
  lastInteractionAt: { type: Date, default: Date.now },
  notes: String
}, { timestamps: true });

// Middleware para atualizar última interação
leadSchema.pre('save', function(next) {
  if (this.interactions && this.interactions.length > 0) {
    this.lastInteractionAt = this.interactions[this.interactions.length - 1].date;
  }
  next();
});

export default mongoose.model('Leads', leadSchema);
