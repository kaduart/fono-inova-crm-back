// models/Leads.js - VERSÃO FINAL AMANDA 2.0
import mongoose from 'mongoose';
import { normalizeE164BR } from '../utils/phone.js';

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
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
  },
  origin: {
    type: String,
    enum: ['WhatsApp', 'Site', 'Indicação', 'Outro', 'Tráfego pago', 'Google', 'Instagram', 'Meta Ads'],
    default: 'Outro'
  },

  appointment: {
    seekingFor: {
      type: String,
      enum: ['Adulto +18 anos', 'Infantil', 'Graduação'],
      default: 'Adulto +18 anos'
    },
    modality: {
      type: String,
      enum: ['Online', 'Presencial'],
      default: 'Online'
    },
    healthPlan: {
      type: String,
      enum: ['Graduação', 'Mensalidade', 'Dependente'],
      default: 'Mensalidade'
    }
  },

  status: {
    type: String,
    enum: [
      'novo',
      'atendimento',
      'convertido',
      'perdido',
      'em_andamento',
      'lista_espera',
      'pendencia_documentacao',
      'sem_cobertura',
      'virou_paciente',
      'lead_quente',
      'lead_frio'
    ],
    default: 'novo',
    index: true
  },

  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  interactions: [interactionSchema],
  lastInteractionAt: { type: Date, default: Date.now },
  notes: String,

  // ✅ CAMPOS AMANDA 2.0
  circuit: { type: String, default: 'Circuito Padrão' },
  scheduledDate: { type: Date },
  convertedToPatient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  conversionScore: { type: Number, default: 0, index: true },
  qualificationData: {
    extractedInfo: { type: mongoose.Schema.Types.Mixed, default: {} },
    intent: String,
    sentiment: String,
    urgencyLevel: Number
  },
  scoreHistory: [{
    score: Number,
    reason: String,
    date: { type: Date, default: Date.now }
  }],
  lastScoreUpdate: Date,

  // ✅ TRACKING DE RESPOSTA
  responded: { type: Boolean, default: false },
  conversationSummary: {
    type: String,
    default: null,
    index: false
  },
  summaryGeneratedAt: {
    type: Date,
    default: null
  },
  summaryCoversUntilMessage: {
    type: Number,
    default: 0
  },
  respondedAt: Date,
  manualControl: {
    active: {
      type: Boolean,
      default: false
    },
    takenOverAt: Date,
    takenOverBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    autoResumeAfter: {
      type: Number,
      default: 720
    }
  },

  autoReplyEnabled: {
    type: Boolean,
    default: true
  },

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ✅ ÍNDICES OTIMIZADOS
leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.index({ origin: 1, createdAt: -1 });
leadSchema.index({ createdAt: -1 });
leadSchema.index({ conversionScore: -1 });
leadSchema.index({ 'contact.phone': 1 });

leadSchema.virtual('phone').get(function () {
  return this.contact?.phone || null;
});


leadSchema.pre('save', function (next) {
  if (this.contact?.phone) this.contact.phone = normalizeE164BR(this.contact.phone);
  next();
});

// Atualizar última interação
leadSchema.pre('save', function (next) {
  if (this.interactions && this.interactions.length > 0) {
    this.lastInteractionAt = this.interactions[this.interactions.length - 1].date;
  }
  next();
});

export default mongoose.model('Leads', leadSchema);