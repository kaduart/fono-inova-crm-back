import mongoose from 'mongoose';

const creditHistorySchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  type: {
    type: String,
    enum: ['initial', 'debit', 'recharge', 'reversal'],
    required: true
  },
  reason: { type: String, default: '' },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { _id: false });

const liminarContractSchema = new mongoose.Schema({
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor:  { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor',  required: true },

  // ─── JURÍDICO (todos opcionais) ────────────────────────────
  processNumber:   { type: String, default: null },
  court:           { type: String, default: null },
  expirationDate:  { type: Date,   default: null },
  mode: {
    type: String,
    enum: ['hybrid', 'immediate', 'deferred'],
    default: 'hybrid'
  },
  authorized: { type: Boolean, default: true },

  // ─── CRÉDITO (fonte de verdade financeira) ─────────────────
  totalCredit:   { type: Number, required: true, min: 0.01 },
  creditBalance: { type: Number, required: true, min: 0 },
  usedCredit:    { type: Number, default: 0 },

  creditHistory: [creditHistorySchema],

  // ─── STATUS ────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['active', 'suspended', 'exhausted', 'expired', 'canceled'],
    default: 'active'
  },

  // ─── RELAÇÕES ──────────────────────────────────────────────
  plans: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TherapeuticPlan' }],

  // ─── RECEBIMENTO FINANCEIRO ────────────────────────────────
  // Data real de entrada do dinheiro (PIX/TED/depósito).
  // Quando informado, tem prioridade sobre creditHistory[0] para financialDate do Payment.
  receivedAt: { type: Date, default: null },

  // ─── IDEMPOTÊNCIA ──────────────────────────────────────────
  idempotencyKey: { type: String, index: true, unique: true, sparse: true },

}, { timestamps: true });

// Virtual: percentual utilizado
liminarContractSchema.virtual('usedPercent').get(function () {
  if (!this.totalCredit) return 0;
  return Math.round((this.usedCredit / this.totalCredit) * 100);
});

liminarContractSchema.set('toJSON',   { virtuals: true });
liminarContractSchema.set('toObject', { virtuals: true });

// Marca contrato como exhausted quando saldo zera
liminarContractSchema.pre('save', function (next) {
  if (this.creditBalance <= 0 && this.status === 'active') {
    this.status = 'exhausted';
  }
  next();
});

const LiminarContract = mongoose.model('LiminarContract', liminarContractSchema);
export default LiminarContract;
