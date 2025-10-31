// models/Leads.js - VERSÃO ATUALIZADA
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
  origin: {
    type: String,
    enum: ['WhatsApp', 'Site', 'Indicação', 'Outro', 'Tráfego pago', 'Google', 'Instagram', 'Meta Ads'],
    default: 'Outro'
  },

  // ✅ CAMPOS NOVOS DA PLANILHA (sem quebrar estrutura existente)
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

  // ✅ STATUS EXPANDIDO (mantendo compatibilidade)
  status: {
    type: String,
    enum: [
      'novo',
      'atendimento',
      'convertido',
      'perdido',
      // Novos status da planilha
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

  // ✅ NOVOS CAMPOS PARA MÉTRICAS
  circuit: { type: String, default: 'Circuito Padrão' },
  scheduledDate: { type: Date },
  convertedToPatient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  conversionScore: { type: Number, default: 0 },

}, { timestamps: true });

// Middleware para atualizar última interação
leadSchema.pre('save', function (next) {
  if (this.interactions && this.interactions.length > 0) {
    this.lastInteractionAt = this.interactions[this.interactions.length - 1].date;
  }
  next();
});

export default mongoose.model('Leads', leadSchema);