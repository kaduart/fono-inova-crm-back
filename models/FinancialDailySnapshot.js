import mongoose from 'mongoose';

const FinancialDailySnapshotSchema = new mongoose.Schema({
  // Chave única: clinica + data
  clinicId: { type: String, default: 'default', index: true },
  date: { type: String, required: true, index: true }, // YYYY-MM-DD

  // Produção (sessões realizadas no dia)
  production: {
    total: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
    byBusinessType: {
      particular: { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
      convenio:   { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
      pacote:     { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
      liminar:    { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
    },
    byPaymentMethod: {
      particular: { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
      convenio:   { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
      pix:        { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
      credit_card:{ total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
    }
  },

  // Caixa (dinheiro efetivamente recebido no dia)
  cash: {
    total: { type: Number, default: 0 },
    particular: { type: Number, default: 0 },
    convenioAvulso: { type: Number, default: 0 },
    convenioPacote: { type: Number, default: 0 },
    liminar: { type: Number, default: 0 },
    byMethod: {
      pix:        { type: Number, default: 0 },
      dinheiro:   { type: Number, default: 0 },
      cartao:     { type: Number, default: 0 },
      outros:     { type: Number, default: 0 },
    }
  },

  // A receber (trabalho feito, dinheiro pendente)
  receivable: {
    total: { type: Number, default: 0 },
    convenio: { type: Number, default: 0 },
    particular: { type: Number, default: 0 },
  },

  // Faturamento (guias enviadas no dia)
  billing: {
    total: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },

  // Pipeline de convênios
  convenio: {
    atendido: { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
    faturado: { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
    recebido: { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
    aReceber: { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  },

  // Agendamentos futuros confirmados no dia
  scheduled: {
    total: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
    avulso: { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
    convenio: { total: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  },

  // Pendentes de confirmação
  pending: {
    total: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },

  // Crédito em pacotes ativo no dia
  packageCredit: {
    total: { type: Number, default: 0 },
    sessions: { type: Number, default: 0 },
  },

  // Contadores de payments (para substituir aggregates de PaymentsView)
  payments: {
    count: { type: Number, default: 0 },
    countPaid: { type: Number, default: 0 },
    countPartial: { type: Number, default: 0 },
    countPending: { type: Number, default: 0 },
    produced: { type: Number, default: 0 },
    received: { type: Number, default: 0 },
    byMethod: {
      pix:        { type: Number, default: 0 },
      cash:       { type: Number, default: 0 },
      credit_card:{ type: Number, default: 0 },
      debit_card: { type: Number, default: 0 },
      bank_transfer:{ type: Number, default: 0 },
      insurance:  { type: Number, default: 0 },
      unknown:    { type: Number, default: 0 },
    },
    byCategory: {
      session: { type: Number, default: 0 },
      package: { type: Number, default: 0 },
      avulso:  { type: Number, default: 0 },
      expense: { type: Number, default: 0 },
      unknown: { type: Number, default: 0 },
    }
  },

  // Controle de versão do snapshot
  version: { type: Number, default: 1 },
  lastEventAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },

  // Profissionais no dia (projeção para ranking)
  professionals: [{
    professionalId: { type: String, required: true },
    production:     { type: Number, default: 0 },
    cash:           { type: Number, default: 0 },
    count:          { type: Number, default: 0 },
    particular:     { type: Number, default: 0 },
    convenio:       { type: Number, default: 0 },
    pacote:         { type: Number, default: 0 },
    liminar:        { type: Number, default: 0 },
  }],

  // 🛡️ Idempotência: guarda eventIds já processados
  processedEvents: {
    type: [String],
    default: [],
    index: true
  }
}, {
  timestamps: { createdAt: true, updatedAt: false },
  versionKey: false,
});

// Índices otimizados para leitura do dashboard
FinancialDailySnapshotSchema.index({ clinicId: 1, date: 1 }, { unique: true });
FinancialDailySnapshotSchema.index({ date: 1 });
FinancialDailySnapshotSchema.index({ updatedAt: 1 });

export default mongoose.model('FinancialDailySnapshot', FinancialDailySnapshotSchema);
