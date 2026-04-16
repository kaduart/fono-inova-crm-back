import mongoose from 'mongoose';

const FinancialDailyExpenseSnapshotSchema = new mongoose.Schema({
  // Chave única: clinica + data
  clinicId: { type: String, default: 'default', index: true },
  date: { type: String, required: true, index: true }, // YYYY-MM-DD

  // Despesas totais do dia
  expenses: {
    total: { type: Number, default: 0 },
    byType: {
      commission: { type: Number, default: 0 },
      fixed: { type: Number, default: 0 },
      variable: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
    }
  },

  // Profissionais no dia (despesa de comissão)
  professionals: [{
    professionalId: { type: String, required: true },
    commission: { type: Number, default: 0 },
    commissionProvisao: { type: Number, default: 0 },
    countSessions: { type: Number, default: 0 },
  }],

  // Controle de versão
  version: { type: Number, default: 1 },
  lastEventAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },

  // 🛡️ Idempotência
  processedEvents: {
    type: [String],
    default: [],
    index: true
  }
}, {
  timestamps: { createdAt: true, updatedAt: false },
  versionKey: false,
});

FinancialDailyExpenseSnapshotSchema.index({ clinicId: 1, date: 1 }, { unique: true });
FinancialDailyExpenseSnapshotSchema.index({ date: 1 });
FinancialDailyExpenseSnapshotSchema.index({ updatedAt: 1 });

export default mongoose.model('FinancialDailyExpenseSnapshot', FinancialDailyExpenseSnapshotSchema);
