/**
 * 💳 ProfessionalAdvance
 *
 * Registra adiantamentos, bonificações e ajustes para profissionais.
 *
 * Regras:
 *   - Nunca apaga. Cancela.
 *   - Pode ser vinculado a um fechamento mensal.
 *   - Só entra no saldo se status === 'active'.
 */

import mongoose from 'mongoose';

const professionalAdvanceSchema = new mongoose.Schema({
  doctor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true,
    index: true
  },

  amount: {
    type: Number,
    required: true,
    min: 0
  },

  date: {
    type: Date,
    required: true,
    index: true
  },

  type: {
    type: String,
    enum: ['advance', 'bonus', 'adjustment'],
    default: 'advance'
  },

  status: {
    type: String,
    enum: ['active', 'cancelled'],
    default: 'active',
    index: true
  },

  notes: {
    type: String,
    default: null
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  cancelledAt: {
    type: Date,
    default: null
  },

  cancelReason: {
    type: String,
    default: null
  },

  settlementId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProfessionalSettlement',
    default: null,
    index: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices para consultas comuns
professionalAdvanceSchema.index({ doctor: 1, status: 1, date: -1 });
professionalAdvanceSchema.index({ doctor: 1, settlementId: 1, status: 1 });

const ProfessionalAdvance = mongoose.model('ProfessionalAdvance', professionalAdvanceSchema);
export default ProfessionalAdvance;
