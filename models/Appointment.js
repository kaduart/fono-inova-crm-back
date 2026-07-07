import mongoose from 'mongoose';
import { syncEvent } from '../services/syncService.js';
import MedicalEvent from './MedicalEvent.js';
import financialSanitizer from './plugins/financialSanitizer.js';
import { NON_BLOCKING_OPERATIONAL_STATUSES } from '../constants/appointmentStatus.js';
import AppointmentWriteGuard from '../services/appointment/AppointmentWriteGuard.js';

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

  // 🕐 Fonte única de verdade temporal (calculada automaticamente via hook)
  startDateTime: { type: Date, required: false },
  endDateTime:   { type: Date, required: false },

  // ─── STATUS ────────────────────────────────────────────────
  operationalStatus: {
    type: String,
    enum: [
      'pre_agendado', // Interesse registrado, aguarda confirmação
      'scheduled',    // Confirmado pela secretaria/paciente
      'confirmed',    // Confirmado pelo profissional
      'pending',
      'canceled',
      // 'suspended' = agendamento do plano antigo pausado por troca/renovação de guia
      // de convênio (replaceInsuranceGuideService) — diferente de 'canceled': não é
      // falta/desistência do paciente, é reorganização interna. Não deve contar como
      // cancelamento nas telas de agenda/caixa.
      'suspended',
      'paid',
      'missed',
      'completed',
      // 🔥 REMOVIDO: 'converted' era estado transitório interno, nunca deveria ter sido persistido
      'processing_create',
      'processing_complete',
      'processing_cancel',
      'force_cancelled' // Reversão administrativa de completed — requer forceCancel:true explícito
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
      'tongue_tie_test', 'neuropsych_evaluation', 'convenio_session', 'liminar_session',
      'consultation', 'joint_session'
    ],
    required: false
  },

  // Sessão Conjunta: mesmo profissional atende dois pacientes no mesmo horário
  isJointSession: {
    type: Boolean,
    default: false,
    index: true
  },
  sessionType: {
    type: String,
    enum: [
      'fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'fisioterapia',
      'pediatria', 'neuroped', 'musicoterapia', 'psicomotricidade', 'psicopedagogia',
      'neuropsych_evaluation', 'neuropsicologia'
    ],
    default: null
  },
  sessionValue: { type: Number, min: 0, default: 0 },
  paymentMethod: {
    type: String,
    enum: [
      'dinheiro', 'pix', 'cartao_credito', 'credito',
      'cartao_debito', 'debito', 'cartão', 'transferencia_bancaria', 'transferencia',
      'plano-unimed', 'convenio', 'liminar_credit', 'outro', null
    ],
    default: 'dinheiro'
  },
  billingType: {
    type: String,
    enum: ['particular', 'convenio', 'liminar'],
    default: 'particular'
  },
  patientJourneyType: {
    type: String,
    enum: ['new_patient', 'new_specialty', 'returning_patient', 'continuous_treatment'],
    default: null,
    index: true
  },
  insuranceProvider: { type: String, default: null },
  insuranceValue: { type: Number, min: 0, default: 0 },
  authorizationCode: { type: String, default: null },
  insuranceGuide: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceGuide', default: null },
  paymentForms: [{
    amount: { type: Number, min: 0 },
    date: { type: Date },
    method: { type: String }
  }],

  // ─── REFERÊNCIAS ───────────────────────────────────────────
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: false },
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
  liminarContract:  { type: mongoose.Schema.Types.ObjectId, ref: 'LiminarContract',  default: null },
  therapeuticPlan:  { type: mongoose.Schema.Types.ObjectId, ref: 'TherapeuticPlan',  default: null },
  insurancePlan:    { type: mongoose.Schema.Types.ObjectId, ref: 'InsurancePlan',    default: null },
  planVersion:      { type: Number, default: null },
  advancedSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: false, description: 'ID do appointment real criado a partir deste pré-agendamento' },
  importedAt: { type: Date, default: null },
  importedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  postAppointmentSentAt: { type: Date, default: null },
  reviewRequestSentAt: { type: Date, default: null },

  // ─── FINANCEIRO EXTRA ──────────────────────────────────────
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'partial', 'canceled', 'advanced', 'package_paid', 'pending_receipt', 'recognized', 'pending_balance', 'unpaid', 'not_applicable'],
    default: 'pending'
  },
  isPaid: {
    type: Boolean,
    default: false
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
      'pediatria', 'neuroped', 'musicoterapia', 'psicopedagogia', 'psicomotricidade', 'neuropsicologia'
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
        enum: ['agenda_externa', 'whatsapp', 'telefone', 'instagram', 'site', 'indicacao', 'amandaAI', 'crm', 'web_app', 'reschedule', 'insurance_guide', 'insurance_plan', 'outro'],
        default: 'outro'
      },
      convertedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      convertedAt: Date
    }
  },

  // 🆕 ARQUITETURA v4.0 - Rastreabilidade Financeira
  paymentOrigin: {
    type: String,
    enum: ['auto_per_session', 'manual_balance', 'package_prepaid', 'convenio', 'liminar', 'liminar_credit', 'individual', 'unknown', 'direct', 'pending', 'updated', 'existing'],
    default: null,
    index: true,
    description: 'Origem do pagamento quando o agendamento for completado'
  },
  
  correlationId: {
    type: String,
    description: 'ID de correlação para rastreamento da transação de conclusão'
  },

  // 🔒 LOCK de processamento (anti duplo clique / retry)
  isProcessing: {
    type: Boolean,
    default: false,
    description: 'Bloqueio temporal durante execução do complete'
  },
  processingStartedAt: {
    type: Date,
    default: null,
    description: 'Timestamp do início do processamento para timeout de recovery'
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
  },

  // ─── REMARCAÇÃO / HISTÓRICO DE CADEIA ──────────────────────
  originalAppointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    default: null,
    index: true,
    description: 'ID do appointment original que foi remarcado'
  },
  rescheduledFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    default: null,
    description: 'ID do appointment imediatamente anterior na cadeia'
  },
  rootAppointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    default: null,
    index: true,
    description: 'ID da raiz da cadeia de remarcações (primeiro appointment)'
  },
  rescheduleReason: {
    type: String,
    default: ''
  },
  rescheduledAt: {
    type: Date,
    default: null
  },

  // ─── CANCELAMENTO ESTRUTURADO ──────────────────────────────
  canceledAt: {
    type: Date,
    default: null
  },
  cancelReason: {
    type: String,
    default: ''
  },

  // ─── AUDITORIA DE FORCE CANCEL ─────────────────────────────
  // Preenchido SOMENTE quando forceCancel:true é usado na rota /cancel
  // Separa reversão administrativa de cancelamento operacional normal
  forceCancelAudit: {
    forceCancelledBy: { type: String, default: null },
    forceCancelledAt: { type: Date, default: null },
    forceCancelledReason: { type: String, default: null },
    reverseFinancial: { type: Boolean, default: false }
  },

  // ─── RASTREABILIDADE DO ATOR ───────────────────────────────
  // Preenchidos pelos commands de appointment para facilitar queries rápidas.
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completedBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  canceledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ─── ÍNDICES ────────────────────────────────────────────────
appointmentSchema.index(
  { originalAppointmentId: 1, date: 1, time: 1 },
  { name: 'reschedule_idempotency' }
);

// ⚠️ MongoDB não suporta $nin/$ne em partialFilterExpression — usar $in com statuses bloqueantes
// e isJointSession: false (equality) para excluir sessões conjuntas do constraint único.
// Após alterar esta definição, rodar: node scripts/migrate-joint-session-index.js
appointmentSchema.index(
  { doctor: 1, date: 1, time: 1 },
  {
    unique: true,
    name: 'unique_appointment_slot',
    partialFilterExpression: {
      operationalStatus: { $in: [
        'pre_agendado', 'scheduled', 'confirmed', 'pending', 'paid',
        'missed', 'processing_create', 'processing_complete', 'processing_cancel', 'force_cancelled'
      ]},
      doctor: { $exists: true },
      isJointSession: false   // joint_session fica fora do constraint — mesmo prof, dois pacientes
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
// Analytics by-type: histórico de paciente filtrado por createdAt (isFirstVisit) + status
appointmentSchema.index({ patient: 1, createdAt: -1, operationalStatus: 1 });
// Query por data sem filtro de clínica (fallback/global)
appointmentSchema.index({ date: 1, operationalStatus: 1 });
// 🔥 OTIMIZAÇÃO: Query calendário por doutor (mais comum)
appointmentSchema.index({ doctor: 1, date: 1 });
// 🔥 OTIMIZAÇÃO: Query calendário por doutor + status
appointmentSchema.index({ doctor: 1, date: 1, operationalStatus: 1 });
// 🔥 OTIMIZAÇÃO: Query por período só (quando não filtra por doctor/patient)
appointmentSchema.index({ date: -1 });

// ─── VIRTUAL ────────────────────────────────────────────────
appointmentSchema.virtual('rescheduleHistory', {
  ref: 'Appointment',
  localField: '_id',
  foreignField: 'originalAppointmentId'
});

appointmentSchema.virtual('originalAppointment', {
  ref: 'Appointment',
  localField: 'originalAppointmentId',
  foreignField: '_id',
  justOne: true
});

appointmentSchema.virtual('daysUntilDate').get(function () {
  if (!this.date) return null;
  const preferred = new Date(this.date);
  const today = new Date();
  return Math.floor((preferred - today) / (1000 * 60 * 60 * 24));
});

// 🕐 Helper: converte date + time + duration → startDateTime / endDateTime
function computeDateTimes(doc) {
  if (!doc.date || !doc.time) return;
  const d = new Date(doc.date);
  const [h, m] = doc.time.split(':').map(Number);
  // date no MongoDB é UTC 12:00 quando salvo via string YYYY-MM-DD
  // Usamos construtor local para respeitar o dia correto
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  const duration = doc.duration || 40;
  const end = new Date(start.getTime() + duration * 60000);
  doc.startDateTime = start;
  doc.endDateTime = end;
}

// ─── MIDDLEWARE PRÉ-SAVE ────────────────────────────────────
appointmentSchema.pre('save', function (next) {
  // 🕐 Calcula startDateTime / endDateTime sempre que necessário
  if (this.isModified('date') || this.isModified('time') || this.isModified('duration') || this.isNew) {
    computeDateTimes(this);
  }

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

  // 🛡️ SEGURANÇA: bloqueia marcação direta de completed fora do completeSessionService
  // ⚠️ IMPORTANTE: operationalStatus é a FONTE DA VERDADE para controle de agendamentos.
  //    NUNCA use clinicalStatus para decidir se uma sessão foi realizada.
  //    Sempre verifique operationalStatus === 'completed'.
  if (this.isModified('operationalStatus') && this.operationalStatus === 'completed' && !this._fromCompleteService) {
    const err = new Error(
      '[SECURITY] operationalStatus=completed só pode ser setado via completeSessionService. ' +
      'Use PATCH /:id/complete ou chame completeSessionV2().'
    );
    err.code = 'FORBIDDEN_MANUAL_COMPLETE';
    return next(err);
  }

  next();
});

appointmentSchema.pre('findOneAndUpdate', async function (next) {
  this.options.runValidators = true;
  this.options.context = 'query';

  const update = this.getUpdate() || {};
  const $set = update.$set || update;

  // 🛡️ SEGURANÇA: bloqueia marcação direta de operationalStatus='completed'
  // via findOneAndUpdate fora do completeSessionService.
  // canceled é intencionalmente NÃO bloqueado aqui porque muitos fluxos legítimos
  // (planos, guias, pacotes, workers) usam updateMany/findByIdAndUpdate para cancelar
  // em massa. Esses fluxos devem ser gradualmente migrados para commands.
  const isFromCompleteService = $set._fromCompleteService === true;
  if ($set.operationalStatus === 'completed' && !isFromCompleteService) {
    const err = new Error(
      '[SECURITY] operationalStatus=completed só pode ser setado via completeSessionService. ' +
      'Use PATCH /:id/complete ou chame completeSessionV2().'
    );
    err.code = 'FORBIDDEN_MANUAL_COMPLETE';
    return next(err);
  }

  // 🕐 Se o update modificar date/time/duration, recalcula startDateTime/endDateTime
  // 🚨 FIX (2026-07-07): antes só recalculava se date E time viessem juntos no update.
  // Um update parcial (só time, ou só date) deixava startDateTime/endDateTime
  // desatualizados — e conflictDetection.js prioriza esses campos sobre date/time,
  // causando "conflito fantasma" com o slot antigo mesmo após o agendamento ser movido.
  // Agora busca no documento atual o(s) campo(s) que não vieram no update.
  if ($set.date !== undefined || $set.time !== undefined || $set.duration !== undefined) {
    try {
      let { date, time, duration } = $set;
      if (date === undefined || time === undefined || duration === undefined) {
        const current = await this.model.findOne(this.getQuery()).select('date time duration').lean();
        if (current) {
          if (date === undefined) date = current.date;
          if (time === undefined) time = current.time;
          if (duration === undefined) duration = current.duration;
        }
      }

      if (date && time) {
        const d = new Date(date);
        const [h, m] = String(time).split(':').map(Number);
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
        const dur = duration || 40;
        const end = new Date(start.getTime() + dur * 60000);
        $set.startDateTime = start;
        $set.endDateTime = end;
        if (!update.$set) update.$set = $set;
      }
    } catch (err) {
      return next(err);
    }
  }

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
    const { default: Payment } = await import('./Payment.js');
    
    // Deletar sessions
    const sessionResult = await Session.deleteMany({ appointmentId });
    console.log(`🧹 Cascade deleteOne: ${sessionResult.deletedCount} sessions removidas do appointment ${appointmentId}`);
    
    // Deletar payments
    const paymentResult = await Payment.deleteMany({ appointment: appointmentId });
    console.log(`🧹 Cascade deleteOne: ${paymentResult.deletedCount} payments removidos do appointment ${appointmentId}`);
  } catch (error) {
    console.error('⚠️ Erro no cascade deleteOne:', error.message);
  }
});

appointmentSchema.pre('deleteMany', async function() {
  const filter = this.getFilter();
  try {
    const { default: Session } = await import('./Session.js');
    const { default: Payment } = await import('./Payment.js');
    
    // Buscar appointments que serão deletados
    const appointments = await mongoose.model('Appointment').find(filter).select('_id');
    const appointmentIds = appointments.map(a => a._id);
    
    if (appointmentIds.length > 0) {
      const sessionResult = await Session.deleteMany({ appointmentId: { $in: appointmentIds } });
      console.log(`🧹 Cascade deleteMany: ${sessionResult.deletedCount} sessions removidas de ${appointmentIds.length} appointments`);
      
      const paymentResult = await Payment.deleteMany({ appointment: { $in: appointmentIds } });
      console.log(`🧹 Cascade deleteMany: ${paymentResult.deletedCount} payments removidos de ${appointmentIds.length} appointments`);
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
    
    // 2. Soft delete nos payments vinculados
    const { default: Payment } = await import('./Payment.js');
    await Payment.updateMany(
      { appointment: appointmentId },
      {
        $set: {
          status: 'canceled',
          canceledAt: new Date(),
          canceledReason: `cascade-delete: ${reason}`
        }
      },
      { session }
    );
    
    // 3. Soft delete no appointment
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deleteReason = reason;
    this.deletedBy = deletedBy;
    await this.save({ session });
    
    await session.commitTransaction();
    console.log(`🧹 Soft delete cascade: appointment ${appointmentId} + sessions + payments vinculados`);
    
    return { success: true, appointmentId };
  } catch (error) {
    await session.abortTransaction();
    console.error('💥 Erro no soft delete cascade:', error.message);
    throw error;
  } finally {
    session.endSession();
  }
};

// 🛡️ Flags de autorização do AppointmentWriteGuard — precisam ser paths reais
// do schema, senão o `strict` (default true) do Mongoose descarta silenciosamente
// esses campos do $set antes de chegar no driver nativo em updates via
// Model.findByIdAndUpdate/findOneAndUpdate (confirmado empiricamente 2026-07-07:
// _fromCancelService sumia do update antes de alcançar collection.findOneAndUpdate,
// o que faria o guard reportar falso positivo em todo cancelamento). `select: false`
// mantém esses campos fora de leituras normais — são só sinalizadores de escrita.
appointmentSchema.add({
  _fromCompleteService: { type: Boolean, select: false },
  _fromCancelService: { type: Boolean, select: false },
  _fromWriteGateway: { type: Boolean, select: false },
  _fromInsuranceOrchestrator: { type: Boolean, select: false },
});

// 💰 Financial Sanitizer — bloqueia writes V1 na origem
appointmentSchema.plugin(financialSanitizer, { entity: 'Appointment' });

const Appointment = mongoose.model('Appointment', appointmentSchema);

// 🛡️ Instala interceptor de writes raw no model Appointment
// Modo padrão: warn (loga, mas não bloqueia). Use APPOINTMENT_WRITE_GUARD_MODE=strict
// em staging/produção quando todos os writes estiverem governados.
AppointmentWriteGuard.install('Appointment', Appointment, [
  'operationalStatus',
  'clinicalStatus',
]);

export default Appointment;
