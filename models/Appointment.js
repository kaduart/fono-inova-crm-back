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
    type: Date,
    required: [true, 'Data é obrigatória'],
    set: function(v) {
      // Se for string "YYYY-MM-DD", converte para Date
      if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [ano, mes, dia] = v.split('-').map(Number);
        return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
      }
      return v;
    }
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
      'missed',
      'completed',
      'processing_create',
      'processing_complete',
      'processing_cancel'
    ],
    default: 'pre_agendado',
  },
  clinicalStatus: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'missed', 'scheduled', 'canceled'],
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
      'dinheiro', 'pix', 'cartao_credito', 'credito',
      'cartao_debito', 'debito', 'cartão', 'transferencia_bancaria', 'transferencia',
      'plano-unimed', 'convenio', 'outro', null
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
    enum: ['pending', 'paid', 'partial', 'canceled', 'advanced', 'package_paid', 'pending_receipt', 'recognized', 'pending_balance'],
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

  // ─── ATRIBUIÇÃO DE LEAD (REVENUE TRACKING) ─────────────────
  // 🆕 NOVO: Conexão com Lead para rastreamento completo de origem → receita
  lead: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Lead',
    index: true 
  },
  
  // 🆕 NOVO: Snapshot imutável do lead no momento do agendamento
  // (evita perda de dados se lead for editado/mergeado depois)
  leadSnapshot: {
    source: { type: String, default: null },           // 'gmb', 'instagram', etc
    campaign: { type: String, default: null },         // 'fala_tardia_2anos'
    origin: { type: String, default: null },           // origem original
    conversionScore: { type: Number, default: null },  // score no momento
    capturedAt: { type: Date, default: null }          // quando o lead entrou
  },

  // 🔥 NOVO: Indica se é o primeiro agendamento do paciente
  // Usado para distinguir novos pacientes (conversões) de recorrentes
  isFirstAppointment: {
    type: Boolean,
    default: false,
    index: true  // facilita queries por tipo
  },

  // ─── CLASSIFICAÇÃO DE PACIENTE (preenchido na importação) ──
  // novo: primeiro contato ever; retorno: voltou após meses; recorrente: já ativo
  patientType: {
    type: String,
    enum: ['novo', 'retorno', 'recorrente'],
    default: null
  },
  // Limiar usado na classificação (em meses — salvo para auditoria)
  patientTypeMonthsInactive: { type: Number, default: null },

  // ─── ORIGEM (ROI) ──────────────────────────────────────────
  metadata: {
    origin: {
      source: {
        type: String,
        enum: ['agenda_externa', 'whatsapp', 'telefone', 'instagram', 'site', 'indicacao', 'amandaAI', 'crm', 'outro'],
        default: 'outro'
      },
      convertedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      convertedAt: Date
    }
  },

  // 🆕 ARQUITETURA v4.0 - Rastreabilidade Financeira
  paymentOrigin: {
    type: String,
    enum: ['auto_per_session', 'manual_balance', 'package_prepaid', 'convenio', 'liminar'],
    default: null,
    index: true,
    description: 'Origem do pagamento quando o agendamento for completado'
  },
  
  correlationId: {
    type: String,
    index: true,
    description: 'ID de correlação para rastreamento da transação de conclusão'
  },
  
  // Campos para saldo devedor (manual_balance)
  addedToBalance: {
    type: Boolean,
    default: false,
    description: 'Se o valor foi adicionado ao saldo devedor do paciente'
  },
  balanceAmount: {
    type: Number,
    default: 0,
    description: 'Valor adicionado ao saldo devedor'
  },
  balanceDescription: {
    type: String,
    description: 'Descrição do saldo devedor'
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
      // 🚨 APENAS canceled não bloqueia o slot (pre_agendado agora BLOQUEIA para evitar duplicatas)
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

// 🆕 V4: Índice único para correlationId (idempotência)
appointmentSchema.index(
    { correlationId: 1 },
    { unique: true, sparse: true }
);

// ─── ÍNDICES DE PERFORMANCE (queries do calendário / listagens) ─
// Query principal do calendário: filtra por clínica + período
appointmentSchema.index({ clinicId: 1, date: 1 });
// Query calendário com filtro de status (caso mais comum)
appointmentSchema.index({ clinicId: 1, date: 1, operationalStatus: 1 });
// Query por paciente + período (histórico, listagem de sessões)
appointmentSchema.index({ patient: 1, date: 1 });
// Query por data sem filtro de clínica (fallback/global)
appointmentSchema.index({ date: 1, operationalStatus: 1 });

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
// IMPORTANTE: setImmediate garante que o response HTTP não aguarda o sync.
// syncEvent é best-effort (falha não impacta o usuário).
appointmentSchema.post('save', function (doc) {
  setImmediate(() => {
    syncEvent(doc, 'appointment').catch(err =>
      console.error('⚠️ Erro no hook post-save (não crítico):', err.message)
    );
  });
});

appointmentSchema.post('findOneAndUpdate', function (doc) {
  if (doc) {
    setImmediate(() => {
      syncEvent(doc, 'appointment').catch(err =>
        console.error('⚠️ Erro no hook post-findOneAndUpdate (não crítico):', err.message)
      );
    });
  }
});

appointmentSchema.post('findOneAndDelete', async function (doc) {
  if (doc) {
    try { 
      await MedicalEvent.deleteOne({ originalId: doc._id, type: 'appointment' }); 
      // 🧹 CASCADE DELETE: Remove sessions vinculadas
      const { default: Session } = await import('./Session.js');
      await Session.deleteMany({ appointmentId: doc._id });
      console.log(`🧹 Cascade delete: sessions do appointment ${doc._id} removidas`);
    }
    catch (error) { console.error('⚠️ Erro no hook post-delete (não crítico):', error.message); }
  }
});

// 🧹 CASCADE DELETE para deleteOne e deleteMany
appointmentSchema.pre('deleteOne', { document: true, query: false }, async function() {
  const appointmentId = this._id;
  try {
    const { default: Session } = await import('./Session.js');
    const result = await Session.deleteMany({ appointmentId });
    console.log(`🧹 Cascade deleteOne: ${result.deletedCount} sessions removidas do appointment ${appointmentId}`);
  } catch (error) {
    console.error('⚠️ Erro no cascade deleteOne:', error.message);
  }
});

appointmentSchema.pre('deleteMany', async function() {
  const filter = this.getFilter();
  try {
    const { default: Session } = await import('./Session.js');
    // Buscar appointments que serão deletados
    const appointments = await mongoose.model('Appointment').find(filter).select('_id');
    const appointmentIds = appointments.map(a => a._id);
    
    if (appointmentIds.length > 0) {
      const result = await Session.deleteMany({ appointmentId: { $in: appointmentIds } });
      console.log(`🧹 Cascade deleteMany: ${result.deletedCount} sessions removidas de ${appointmentIds.length} appointments`);
    }
  } catch (error) {
    console.error('⚠️ Erro no cascade deleteMany:', error.message);
  }
});

// 🧹 MÉTODO: Soft delete em cascata
appointmentSchema.methods.softDeleteCascade = async function(reason = 'manual', deletedBy = null) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const appointmentId = this._id;
    
    // 1. Soft delete nas sessions vinculadas
    const { default: Session } = await import('./Session.js');
    await Session.updateMany(
      { appointmentId },
      { 
        $set: { 
          isDeleted: true, 
          deletedAt: new Date(), 
          deleteReason: `cascade-delete: ${reason}`,
          deletedBy 
        } 
      },
      { session }
    );
    
    // 2. Soft delete no appointment
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deleteReason = reason;
    this.deletedBy = deletedBy;
    await this.save({ session });
    
    await session.commitTransaction();
    console.log(`🧹 Soft delete cascade: appointment ${appointmentId} + sessions vinculadas`);
    
    return { success: true, appointmentId };
  } catch (error) {
    await session.abortTransaction();
    console.error('💥 Erro no soft delete cascade:', error.message);
    throw error;
  } finally {
    session.endSession();
  }
};

const Appointment = mongoose.model('Appointment', appointmentSchema);
export default Appointment;
