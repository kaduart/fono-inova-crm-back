import mongoose from 'mongoose';
import { syncEvent } from '../services/syncService.js';
import MedicalEvent from './MedicalEvent.js';
import { NON_BLOCKING_OPERATIONAL_STATUSES } from '../constants/appointmentStatus.js';

// Sub-schema: tentativas de contato (vinha do PreAgendamento)
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

const appointmentSchema = new mongoose.Schema({

  // ─── PACIENTE ─────────────────────────────────────────────
  // Opcional em pré-agendamentos (paciente ainda não cadastrado)
  patient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: false
  },

  // Dados brutos do paciente para pré-agendamentos sem patientId
  patientInfo: {
    fullName: String,
    phone: String,
    email: String,
    birthDate: String,
    age: Number,
    ageUnit: { type: String, enum: ['anos', 'meses'], default: 'anos' }
  },

  // ─── PROFISSIONAL ──────────────────────────────────────────
  doctor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: false
  },
  professionalName: String, // nome texto para pré-agendamentos sem doctorId

  // ─── DATA / HORA ───────────────────────────────────────────
  date: {
    type: String,
    required: [true, 'Data é obrigatória']
  },
  time: {
    type: String,
    required: false,
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Formato de horário inválido (HH:MM)']
  },
  // Para pré-agendamentos com preferência de período (sem horário fixo)
  preferredPeriod: {
    type: String,
    enum: ['manha', 'tarde', 'noite', null],
    default: null
  },
  duration: { type: Number, default: 40 },

  // ─── STATUS ────────────────────────────────────────────────
  operationalStatus: {
    type: String,
    enum: [
      'pre_agendado', // Interesse registrado, aguarda confirmação
      'scheduled',    // Confirmado pela secretaria/paciente
      'confirmed',    // Confirmado pelo profissional
      'pending',
      'canceled',
      'paid',
      'missed'
    ],
    default: 'pre_agendado',
  },
  clinicalStatus: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'missed'],
    default: 'pending',
  },

  // ─── FLUXO DE PRÉ-AGENDAMENTO ─────────────────────────────
  // Urgência calculada com base na data preferida
  urgency: {
    type: String,
    enum: ['baixa', 'media', 'alta', 'critica'],
    default: 'media'
  },
  // Responsável pelo follow-up
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // Tentativas de contato com o paciente
  contactAttempts: [contactAttemptSchema],
  attemptCount: { type: Number, default: 0 },
  // Descarte
  discardReason: String,
  discardedAt: Date,
  discardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Expiração (30 dias sem ação)
  expiresAt: Date,

  // ─── SERVIÇO / PAGAMENTO ───────────────────────────────────
  serviceType: {
    type: String,
    enum: [
      'evaluation', 'session', 'package_session',
      'individual_session', 'meet', 'alignment', 'return',
      'tongue_tie_test', 'neuropsych_evaluation', 'convenio_session'
    ],
    required: false
  },
  sessionValue: { type: Number, min: 0, default: 0 },
  paymentMethod: {
    type: String,
    enum: [
      'dinheiro', 'pix', 'cartao_credito',
      'cartao_debito', 'cartão', 'transferencia_bancaria',
      'plano-unimed', 'convenio', 'outro'
    ],
    default: 'dinheiro'
  },
  billingType: {
    type: String,
    enum: ['particular', 'convenio'],
    default: 'particular'
  },
  insuranceProvider: { type: String, default: null },
  insuranceValue: { type: Number, min: 0, default: 0 },
  authorizationCode: { type: String, default: null },

  // ─── REFERÊNCIAS ───────────────────────────────────────────
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: false },
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
  advancedSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],

  // ─── FINANCEIRO EXTRA ──────────────────────────────────────
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'partial', 'canceled', 'advanced', 'package_paid', 'pending_receipt'],
    default: 'pending'
  },
  visualFlag: {
    type: String,
    enum: ['ok', 'pending', 'partial', 'blocked'],
    default: 'pending'
  },
  addedToBalance: { type: Boolean, default: false },
  balanceAmount: { type: Number, default: 0 },
  balanceDescription: { type: String, default: null },

  // ─── TEXTOS ────────────────────────────────────────────────
  notes: { type: String, default: '' },
  responsible: { type: String, default: '' },
  secretaryNotes: String,

  // ─── ESPECIALIDADE ─────────────────────────────────────────
  specialty: {
    type: String,
    required: true,
    enum: [
      'fonoaudiologia', 'terapia_ocupacional', 'psicologia',
      'tongue_tie_test', 'neuropsych_evaluation', 'fisioterapia',
      'pediatria', 'neuroped', 'musicoterapia', 'psicopedagogia', 'psicomotricidade'
    ],
    set: v => typeof v === 'string' ? v.toLowerCase() : v
  },

  // ─── HISTÓRICO ─────────────────────────────────────────────
  history: [{
    action: String,
    newStatus: String,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: Date,
    context: String
  }],

  // ─── ORIGEM (ROI) ──────────────────────────────────────────
  metadata: {
    origin: {
      source: {
        type: String,
        enum: ['agenda_externa', 'whatsapp', 'telefone', 'instagram', 'site', 'indicacao', 'amandaAI', 'outro'],
        default: 'outro'
      },
      convertedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      convertedAt: Date
    }
  }

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ─── ÍNDICES ────────────────────────────────────────────────
appointmentSchema.index(
  { doctor: 1, date: 1, time: 1 },
  {
    unique: true,
    name: 'unique_appointment_slot',
    partialFilterExpression: {
      // pre_agendado e canceled não bloqueiam o slot
      operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
      doctor: { $exists: true, $ne: null }
    }
  }
);
appointmentSchema.index({ operationalStatus: 1, createdAt: -1 });
appointmentSchema.index({ specialty: 1, date: 1 });
appointmentSchema.index({ 'patientInfo.phone': 1 });
appointmentSchema.index({ assignedTo: 1, operationalStatus: 1 });
appointmentSchema.index({ urgency: 1, createdAt: -1 });

// ─── VIRTUAL ────────────────────────────────────────────────
appointmentSchema.virtual('daysUntilDate').get(function () {
  if (!this.date) return null;
  const preferred = new Date(this.date);
  const today = new Date();
  return Math.floor((preferred - today) / (1000 * 60 * 60 * 24));
});

// ─── MIDDLEWARE PRÉ-SAVE ────────────────────────────────────
appointmentSchema.pre('save', function (next) {
  // Urgência só calculada para pré-agendamentos
  if (this.operationalStatus === 'pre_agendado' && (this.isModified('date') || this.isNew)) {
    const days = this.daysUntilDate;
    if (days === null) { this.urgency = 'media'; }
    else if (days < 0) this.urgency = 'critica';
    else if (days <= 2) this.urgency = 'alta';
    else if (days <= 7) this.urgency = 'media';
    else this.urgency = 'baixa';

    if (!this.expiresAt) {
      const expires = new Date();
      expires.setDate(expires.getDate() + 30);
      this.expiresAt = expires;
    }
  }
  next();
});

appointmentSchema.pre('findOneAndUpdate', function (next) {
  this.options.runValidators = true;
  this.options.context = 'query';
  next();
});

// ─── HOOKS PÓS-SAVE ────────────────────────────────────────
appointmentSchema.post('save', async function (doc) {
  try { await syncEvent(doc, 'appointment'); }
  catch (error) { console.error('⚠️ Erro no hook post-save (não crítico):', error.message); }
});

appointmentSchema.post('findOneAndUpdate', async function (doc) {
  if (doc) {
    try { await syncEvent(doc, 'appointment'); }
    catch (error) { console.error('⚠️ Erro no hook post-findOneAndUpdate (não crítico):', error.message); }
  }
});

appointmentSchema.post('findOneAndDelete', async function (doc) {
  if (doc) {
    try { await MedicalEvent.deleteOne({ originalId: doc._id, type: 'appointment' }); }
    catch (error) { console.error('⚠️ Erro no hook post-delete (não crítico):', error.message); }
  }
});

const Appointment = mongoose.model('Appointment', appointmentSchema);
export default Appointment;
