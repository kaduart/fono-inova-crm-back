// models/Leads.js - VERSÃO FINAL AMANDA 2.0
import mongoose from 'mongoose';
import { normalizeE164BR } from '../utils/phone.js';

const interactionSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  channel: { type: String, enum: ['whatsapp', 'WhatsApp', 'telefone', 'email', 'manual'], default: 'manual' }, direction: { type: String, enum: ['inbound', 'outbound'], default: 'outbound' },
  message: String,
  note: String,
  status: { type: String, enum: ['sent', 'received', 'failed', 'read', 'completed'], default: 'sent' },
  acceptedPrivateCare: { type: Boolean, default: null },
  insuranceHardNo: { type: Boolean, default: false },
  triageStep: {
    type: String,
    enum: [
      'ask_profile',     // idade
      'ask_complaint',   // queixa/motivo
      'ask_period',      // dia/período
      'done'
    ],
    default: null,
  },
});

const leadSchema = new mongoose.Schema({
  name: { type: String, default: null },
  contact: {
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
  },
  origin: {
    type: String,
    enum: ['WhatsApp', 'Site', 'Indicação', 'Outro', 'Tráfego pago', 'Google', 'Instagram', 'Meta Ads'],
    default: 'Outro'
  },
  urgencyApplied: { type: String, default: null },
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
  stage: {
    type: String,
    enum: [
      'novo',
      'pesquisando_preco',
      'triagem_agendamento',
      'engajado',
      'interessado_agendamento',
      'paciente'
    ],
    default: 'novo',
    index: true
  },

  autoBookingContext: {
    type: {
      active: { type: Boolean, default: false },
      therapyArea: { type: String, default: null },
      mappedTherapyArea: { type: String, default: null },
      mappedSpecialties: { type: [String], default: [] },
      mappedProduct: { type: String, default: null },
      lastOfferedSlots: {
        primary: { type: Object, default: null },
        alternativesSamePeriod: { type: Array, default: [] },
      },
      preferredPeriod: { type: String, enum: ['manha', 'tarde', 'noite', null], default: null },
      patientInfo: {
        fullName: String,
        birthDate: String,
        phone: String,
        email: String,
        age: Number, // 🆕 Idade do paciente
      },
      // ✅ flags usados pelo orquestrador (persistência real no Mongo)
      awaitingPeriodChoice: { type: Boolean, default: false },
      schedulingIntentActive: { type: Boolean, default: false },
      handoffSentAt: { type: Date, default: null },
      complaint: { type: String, default: null },

      // 🆕 Novos campos para agendamento robusto
      schedulingRequested: { type: Boolean, default: false },
      schedulingRequestedAt: { type: Date, default: null },
      pendingSchedulingSlots: { type: Object, default: null },
      lastSlotsShownAt: { type: Date, default: null },

      // 🆕 Waitlist (Lista de Espera)
      waitlistRequested: { type: Boolean, default: false },
      waitlistPreferences: {
        therapyArea: String,
        period: String,
        urgency: String,
        requestedAt: Date
      },

      // 🆕 Metadados conversacionais
      messageCount: { type: Number, default: 0 },
      lastMessage: { type: String, default: null },
      lastAction: { type: String, default: null },
      currentStep: { type: String, default: null },
      lastUpdatedAt: { type: Date, default: null },
    },
    default: null,
  },
  therapyArea: { type: String, default: null },
  urgencyApplied: { type: String, default: null },
  status: {
    type: String,
    enum: [
      'novo',
      'engajado',
      'atendimento',
      'convertido',
      'perdido',
      'em_andamento',
      'lista_espera',
      'pendencia_documentacao',
      'sem_cobertura',
      'virou_paciente',
      'lead_quente',
      'lead_frio',
      'agendado'
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

  // 🆕 TRACKING DE CONTATO PARA WARM RECALL
  lastContactAt: { type: Date, default: null, index: true },
  lastFollowUpAt: { type: Date, default: null },

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
  awaitingResponse: { type: String, default: null },
  autoReplyEnabled: {
    type: Boolean,
    default: true
  },

  patientInfo: {
    fullName: String,
    birthDate: String,   // "YYYY-MM-DD"
    phone: String,
    email: String,
    age: Number,           // ← NOVO: 4 (anos)
    ageUnit: String,
  },
  // ✅ V8 FSM — Máquina de Estados
  currentState: {
    type: String,
    enum: [
      'IDLE',              // Aguardando primeira mensagem
      'GREETING',          // Saudação inicial
      'COLLECT_THERAPY',   // Coletando área terapêutica
      'COLLECT_NAME',      // Coletando nome do paciente
      'COLLECT_BIRTH',     // Coletando data de nascimento
      'COLLECT_COMPLAINT', // Coletando queixa
      'COLLECT_PERIOD',    // Coletando período preferido
      'SHOW_SLOTS',        // Mostrando horários disponíveis
      'CONFIRM_BOOKING',   // Confirmando agendamento
      'COLLECT_PATIENT_DATA', // Coletando dados finais do paciente
      'BOOKED',            // Agendamento confirmado
      'INTERRUPTED',       // Interrupção global (preço, local, etc)
      'HANDOFF',           // Encaminhado para humano
    ],
    default: 'IDLE',
    index: true,
  },
  stateData: { type: mongoose.Schema.Types.Mixed, default: {} },
  stateStack: [{
    state: String,
    data: mongoose.Schema.Types.Mixed,
    suspendedAt: { type: Date, default: Date.now },
    reason: String,
  }],
  retryCount: { type: Number, default: 0 }, // Contador anti-loop (handoff após 3)

  // ✅ Commit 2: anti-corrida (trava no Mongo)
  isProcessing: { type: Boolean, default: false },
  processingStartedAt: { type: Date, default: null },
  pendingPreferredPeriod: { type: String, enum: ['manha', 'tarde', 'noite', null], default: null },
  pendingPatientInfoForScheduling: { type: Boolean, default: false },
  pendingSchedulingSlots: { type: mongoose.Schema.Types.Mixed, default: null },
  pendingChosenSlot: { type: mongoose.Schema.Types.Mixed, default: null },
  pendingPatientInfoStep: { type: String, default: null },

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