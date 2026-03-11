/**
 * 📊 MetaCampaign Model
 * Cache local das campanhas do Meta Ads para performance
 * Evita bater na API do Meta toda hora (rate limits)
 */

import mongoose from 'mongoose';

const metaCampaignSchema = new mongoose.Schema({
  // Identificadores
  campaignId: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  accountId: { 
    type: String, 
    default: 'act_976430640058336'  // Conta principal da Fono Inova
  },
  
  // Dados da campanha
  name: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', ''], 
    default: '' 
  },
  objective: { type: String, default: null },  // OUTCOME_SALES, etc
  
  // Orçamento
  dailyBudget: { type: Number, default: null },  // Em centavos (API retorna assim)
  lifetimeBudget: { type: Number, default: null },
  
  // Métricas acumuladas (atualizadas periodicamente)
  insights: {
    spend: { type: Number, default: 0 },           // Gasto total em reais
    clicks: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    cpc: { type: Number, default: null },          // Custo por clique
    ctr: { type: Number, default: null },          // Click-through rate
    cpm: { type: Number, default: null },          // Custo por 1000 impressões
    conversions: { type: Number, default: 0 },
    costPerConversion: { type: Number, default: null },
    
    // Período dos insights
    dateStart: { type: Date, default: null },
    dateStop: { type: Date, default: null },
  },
  
  // Métricas calculadas localmente (denormalizadas)
  leadsCount: { type: Number, default: 0 },        // Quantidade de leads gerados
  patientsCount: { type: Number, default: 0 },     // Quantidade que virou paciente
  
  // Inferência automática
  specialty: {
    type: String,
    enum: ['psicologia', 'fono', 'fisio', 'neuropsicologia', 'psicopedagogia', 'geral', ''],
    default: ''
  },
  
  // Flags
  isActive: { type: Boolean, default: true },
  
  // Sincronização
  lastSyncAt: { type: Date, default: Date.now },
  syncStatus: { 
    type: String, 
    enum: ['synced', 'pending', 'error'], 
    default: 'pending' 
  },
  
  // Metadados da API
  rawData: { type: mongoose.Schema.Types.Mixed, default: null },  // Dados brutos da API (debug)
  
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtuals para cálculos dinâmicos
metaCampaignSchema.virtual('cpl').get(function() {
  // Custo Por Lead = Gasto / Quantidade de leads
  if (this.leadsCount > 0 && this.insights.spend > 0) {
    return this.insights.spend / this.leadsCount;
  }
  return null;
});

metaCampaignSchema.virtual('cpa').get(function() {
  // Custo Por Aquisição = Gasto / Quantidade de pacientes
  if (this.patientsCount > 0 && this.insights.spend > 0) {
    return this.insights.spend / this.patientsCount;
  }
  return null;
});

metaCampaignSchema.virtual('formattedSpend').get(function() {
  // Formata como R$ 1.234,56
  if (this.insights.spend) {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(this.insights.spend);
  }
  return 'R$ 0,00';
});

// Métodos estáticos úteis
metaCampaignSchema.statics.findActive = function() {
  return this.find({ status: 'ACTIVE', isActive: true });
};

metaCampaignSchema.statics.findBySpecialty = function(specialty) {
  return this.find({ specialty });
};

// Índices otimizados
metaCampaignSchema.index({ status: 1, isActive: 1 });
metaCampaignSchema.index({ specialty: 1 });
metaCampaignSchema.index({ lastSyncAt: 1 });

const MetaCampaign = mongoose.model('MetaCampaign', metaCampaignSchema);

export default MetaCampaign;
