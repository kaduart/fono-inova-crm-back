// models/schemas/GuidePolicySchema.js
import mongoose from 'mongoose';

/**
 * 📋 Sub-schema de política operacional de guias por convênio.
 *
 * Define como as guias daquele convênio funcionam: quando vencem,
 * quando avisar, quantas sessões sugerir e como migrar atendimentos.
 *
 * Este schema não contém lógica de negócio — apenas configuração.
 * A interpretação das regras fica em GuideLifecycleService / strategies.
 */
const GuidePolicySchema = new mongoose.Schema({
  // Como a guia vence / exige renovação
  renewalType: {
    type: String,
    enum: [
      'end_of_month',           // vence no último dia do mês (Bradesco, Unimed FESP/Campinas)
      'until_consumed',         // não vence por data; esgota ao consumir sessões (Unimed Anápolis)
      'fixed_date',             // vence em uma data fixa específica
      'authorization_validity'  // válida pelo período da autorização
    ],
    required: [true, 'renewalType é obrigatório'],
    default: 'end_of_month'
  },

  // Para renewalType === 'end_of_month': último dia do mês ou dia fixo
  renewalDay: {
    type: String,
    enum: ['last_day', 'fixed_day'],
    default: 'last_day'
  },

  // Para renewalDay === 'fixed_day': qual dia do mês (1-31)
  renewalDayOfMonth: {
    type: Number,
    default: null,
    min: 1,
    max: 31
  },

  // Dias antes do vencimento para exibir aviso (apenas para tipos com data)
  expirationWarningDays: {
    type: Number,
    default: 5,
    min: 0
  },

  // Se o sistema deve sugerir renovação proativamente ao se aproximar do vencimento
  autoSuggestRenewal: {
    type: Boolean,
    default: true
  },

  // Estratégia padrão de migração de atendimentos ao renovar
  defaultMigrationStrategy: {
    type: String,
    enum: ['eligible', 'manual', 'none'],
    default: 'eligible'
  }
}, {
  _id: false
});

export default GuidePolicySchema;
