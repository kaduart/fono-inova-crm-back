/**
 * 📋 ProfessionalSettlement
 *
 * Documento financeiro histórico de fechamento mensal por profissional.
 *
 * Regras:
 *   - Nunca recalculado após fechamento.
 *   - Snapshot completo salvo no documento.
 *   - Adiantamentos vinculados explicitamente.
 *   - Índice único por (doctor, periodMonth, periodYear).
 */

import mongoose from 'mongoose';

const professionalSettlementSchema = new mongoose.Schema({
  doctor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true,
    index: true
  },

  periodMonth: {
    type: Number,
    required: true,
    min: 1,
    max: 12
  },

  periodYear: {
    type: Number,
    required: true
  },

  status: {
    type: String,
    enum: ['open', 'closed', 'cancelled'],
    default: 'open'
  },

  closedAt: {
    type: Date,
    default: null
  },

  closedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  cancelledAt: {
    type: Date,
    default: null
  },

  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  cancelReason: {
    type: String,
    default: null
  },

  // ── Snapshot congelado ──
  snapshot: {
    patients: {
      active: { type: Number, default: 0 },
      new: { type: Number, default: 0 },
      inactive: { type: Number, default: 0 },
      total: { type: Number, default: 0 }
    },
    commissionRules: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      description: 'Regras de comissão vigentes no momento do fechamento'
    },
    sessions: {
      completed: { type: Number, default: 0 }
    },
    production: {
      total: { type: Number, default: 0 },
      particular: { type: Number, default: 0 },
      pacote: { type: Number, default: 0 },
      convenio: { type: Number, default: 0 },
      liminar: { type: Number, default: 0 }
    },
    received: {
      total: { type: Number, default: 0 },
      particular: { type: Number, default: 0 },
      convenio: { type: Number, default: 0 },
      liminar: { type: Number, default: 0 }
    },
    pending: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
    advances: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }
  },

  // ── Adiantamentos vinculados ──
  linkedAdvances: [{
    advanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProfessionalAdvance' },
    amount: { type: Number, required: true },
    type: { type: String, enum: ['advance', 'bonus', 'adjustment'] },
    date: { type: Date }
  }],

  // ── Auditoria ──
  reconciliationHealth: {
    orphanSessions: { type: Number, default: 0 },
    orphanPayments: { type: Number, default: 0 },
    commissionMismatch: { type: Number, default: 0 }
  },

  // ── Observações ──
  notes: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Índice único por profissional + período
professionalSettlementSchema.index(
  { doctor: 1, periodYear: 1, periodMonth: 1 },
  { unique: true, name: 'unique_doctor_period' }
);

// Índice para histórico
professionalSettlementSchema.index({ doctor: 1, periodYear: -1, periodMonth: -1 });

const ProfessionalSettlement = mongoose.model('ProfessionalSettlement', professionalSettlementSchema);
export default ProfessionalSettlement;
