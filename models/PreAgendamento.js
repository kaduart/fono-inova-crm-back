import mongoose from 'mongoose';

/**
 * PreAgendamento - Representa um interesse de agendamento
 * que ainda não foi confirmado/convertido para um Appointment definitivo
 * 
 * Fluxo:
 * 1. Agenda externa (ou Amanda) cria PreAgendamento
 * 2. Secretária visualiza em painel
 * 3. Ao confirmar, converte para Appointment
 */

const contactAttemptSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  channel: {
    type: String,
    enum: ['whatsapp', 'telefone', 'email', 'manual'],
    required: true
  },
  success: { type: Boolean, default: false },
  notes: String,
  madeBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });

const preAgendamentoSchema = new mongoose.Schema({
  // Origem do pré-agendamento
  source: {
    type: String,
    default: 'agenda_externa',
    enum: ['agenda_externa', 'whatsapp', 'telefone', 'instagram', 'site', 'indicacao', 'outro']
  },
  externalId: {
    type: String,
    index: true,
    description: 'ID na agenda externa (Firebase/etc)'
  },

  // Informações do paciente
  patientInfo: {
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    email: String,
    birthDate: String,
    age: Number,
    ageUnit: { type: String, enum: ['anos', 'meses'], default: 'anos' }
  },

  // Referência ao paciente se já existir no CRM
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient'
  },

  // Preferências de agendamento
  specialty: {
    type: String,
    required: true,
    enum: [
      'fonoaudiologia',
      'terapia_ocupacional',
      'psicologia',
      'fisioterapia',
      'musicoterapia',
      'psicopedagogia',
      'tongue_tie_test',
      'neuropsych_evaluation',
      'pediatria',
      'neuroped'
    ]
  },
  preferredDate: { type: String, required: true }, // YYYY-MM-DD
  preferredTime: String, // HH:MM
  preferredPeriod: {
    type: String,
    enum: ['manha', 'tarde', 'noite', null],
    default: null
  },
  professionalName: String, // Nome do profissional preferido (opcional)
  professionalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },

  // Tipo de serviço
  serviceType: {
    type: String,
    enum: ['evaluation', 'session', 'package_session', 'return'],
    default: 'evaluation'
  },

  // Status no fluxo
  status: {
    type: String,
    enum: [
      'novo',           // Recém criado, ninguém viu
      'em_analise',     // Alguém está trabalhando nisso
      'contatado',      // Tentativa de contato feita
      'confirmado',     // Paciente confirmou interesse
      'importado',      // Convertido para Appointment
      'descartado',     // Não vai prosseguir
      'expirado'        // Data passou sem ação
    ],
    default: 'novo',
    index: true
  },

  // Valor sugerido (pode ser definido na confirmação)
  suggestedValue: { type: Number, default: 0 },

  // Se foi convertido para agendamento definitivo
  importedToAppointment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  importedAt: Date,
  importedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Se foi descartado
  discardReason: String,
  discardedAt: Date,
  discardedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Tentativas de contato
  contactAttempts: [contactAttemptSchema],

  // Notas da secretária
  secretaryNotes: String,

  // Responsável atual
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Urgência calculada
  urgency: {
    type: String,
    enum: ['baixa', 'media', 'alta', 'critica'],
    default: 'media'
  },

  // Contador de tentativas
  attemptCount: { type: Number, default: 0 },

  // Data de expiração (se passar sem ação)
  expiresAt: Date

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices para performance
preAgendamentoSchema.index({ status: 1, createdAt: -1 });
preAgendamentoSchema.index({ specialty: 1, preferredDate: 1 });
preAgendamentoSchema.index({ 'patientInfo.phone': 1 });
preAgendamentoSchema.index({ assignedTo: 1, status: 1 });
preAgendamentoSchema.index({ urgency: 1, createdAt: -1 });

// Virtual para calcular dias até a data preferida
preAgendamentoSchema.virtual('daysUntilPreferred').get(function () {
  const preferred = new Date(this.preferredDate);
  const today = new Date();
  const diff = Math.floor((preferred - today) / (1000 * 60 * 60 * 24));
  return diff;
});

// Middleware para calcular urgência antes de salvar
preAgendamentoSchema.pre('save', function (next) {
  if (this.isModified('preferredDate') || this.isNew) {
    const days = this.daysUntilPreferred;
    if (days < 0) this.urgency = 'critica';
    else if (days <= 2) this.urgency = 'alta';
    else if (days <= 7) this.urgency = 'media';
    else this.urgency = 'baixa';

    // Expira em 30 dias se não for importado
    if (!this.expiresAt) {
      const expires = new Date();
      expires.setDate(expires.getDate() + 30);
      this.expiresAt = expires;
    }
  }
  next();
});

const PreAgendamento = mongoose.model('PreAgendamento', preAgendamentoSchema);
export default PreAgendamento;
