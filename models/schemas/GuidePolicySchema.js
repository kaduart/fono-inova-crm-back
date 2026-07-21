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
      'authorization_validity', // válida pelo período da autorização
      'advance_authorization'   // autorização solicitada antes do início do atendimento (ex: Unimed Fesp, dia 20 do mês anterior)
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
  },

  // Dia do mês limite para envio da fatura/guia ao convênio (ex: Bradesco exige envio até dia 29)
  // Independente do vencimento da guia (renewalDay) — é um prazo operacional de faturamento
  billingSubmissionDay: {
    type: Number,
    default: null,
    min: 1,
    max: 31
  },

  // Para renewalType === 'advance_authorization': dia do mês anterior ao atendimento
  // em que a solicitação de autorização prévia deve ser enviada (ex: Unimed Fesp, dia 20)
  priorAuthRequestDay: {
    type: Number,
    default: null,
    min: 1,
    max: 31
  },

  // Para renewalType === 'advance_authorization': e-mail de destino da solicitação de autorização prévia
  priorAuthEmail: {
    type: String,
    default: '',
    trim: true
  },

  // E-mail de destino do faturamento (NF + lista de presença) — genérico, usado por qualquer tipo de convênio
  // Ex: Unimed Campinas exige envio pra pagamento.prestadores@unimedcampinas.com.br
  billingEmail: {
    type: String,
    default: '',
    trim: true
  },

  // Prazo pra emitir a NF/fatura em dias corridos a partir da data do atendimento (não é dia fixo do mês)
  // Ex: Unimed Campinas exige emissão em até 30 dias corridos do atendimento
  billingDeadlineDays: {
    type: Number,
    default: null,
    min: 0
  }
}, {
  _id: false
});

export default GuidePolicySchema;
