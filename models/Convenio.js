import mongoose from 'mongoose';
import GuidePolicySchema from './schemas/GuidePolicySchema.js';
import CommunicationRuleSchema from './schemas/CommunicationRuleSchema.js';
import { resolveConvenioSessionValue } from '../utils/resolveConvenioSessionValue.js';

/**
 * 🏥 Convenio Model
 * 
 * Armazena os valores de reembolso/faturamento por convênio.
 * Usado para calcular receita esperada de sessões de convênio.
 */
const convenioSchema = new mongoose.Schema({
  // Identificação
  code: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  // Valor de reembolso por sessão
  sessionValue: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  
  // Tabela de valores POR ESPECIALIDADE (ex.: fonoaudiologia 70, fisioterapia 55).
  // `sessionValue` acima é o valor padrão para especialidade sem linha aqui.
  // Resolução: utils/resolveConvenioSessionValue.js — o valor é CONGELADO na guia ao criá-la
  // (InsuranceGuide.sessionValue é a fonte oficial), então editar a tabela não afeta guias existentes.
  specialtyValues: {
    type: [{
      _id: false,
      specialty: { type: String, required: true, lowercase: true, trim: true },
      sessionValue: { type: Number, required: true, min: 0 },
      // Valor nominal da AVALIAÇÃO desta terapia (0 = não definido). ABA soma 50% na guia.
      evaluationValue: { type: Number, min: 0, default: 0 }
    }],
    default: []
  },

  // Adicional (%) pago pelo convênio em atendimento ABA, sobre o valor da especialidade.
  // 0 = convênio NÃO paga adicional ABA (a guia nem oferece o switch). Só alguns convênios têm.
  // Aplicado ao criar a guia marcada como ABA (InsuranceGuide.isAba) e congelado no valor da guia.
  abaSurchargePercent: {
    type: Number,
    min: 0,
    max: 500,
    default: 0
  },

  // Status
  active: {
    type: Boolean,
    default: true
  },
  
  // Modo de faturamento padrão para novas guias deste convênio
  // Congelado na guia no momento da criação — alterar aqui não afeta guias existentes
  billingMode: {
    type: String,
    enum: ['per_month', 'per_guide'],
    default: 'per_month'
  },

  // Quantidade padrão de sessões sugerida ao criar/renovar guia
  defaultSessions: {
    type: Number,
    default: null,
    min: 1
  },

  // Alíquota de imposto retido na fonte pelo convênio ao pagar (ex: ISS Unimed = 2.01), em %.
  // Deduzida automaticamente do valor bruto ao registrar recebimento (ConvenioMetricsService).
  issRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },

  // Regras operacionais de renovação — define como as guias deste convênio funcionam
  guidePolicy: GuidePolicySchema,

  // Regras de comunicação com convênio — por propósito (autorização, faturamento, etc.)
  communicationRules: {
    authorization: CommunicationRuleSchema,
    billing: CommunicationRuleSchema,
    appeal: CommunicationRuleSchema,
    documentation: CommunicationRuleSchema
  },

  // LEGADO: mantido para compatibilidade durante migration; usar communicationRules.authorization
  authorizationRules: CommunicationRuleSchema,

  // Dados fiscais do convênio — usados como destinatário ao emitir a NF (não é comportamento de guia)
  legalName: {
    type: String,
    default: '',
    trim: true
  },

  taxId: {
    type: String,
    default: '',
    trim: true
  },

  // Observações
  notes: {
    type: String,
    default: ''
  }

}, {
  timestamps: true
});

// Índices — code já indexado via unique:true
convenioSchema.index({ active: 1 });

// Método para obter regras de comunicação por propósito (com fallback legado)
convenioSchema.methods.getCommunicationRules = function(purpose = 'authorization') {
  return this.communicationRules?.[purpose] || this.communicationRules?.authorization || this.authorizationRules || {};
};

// Método estático para obter valor por código
// `specialty` é opcional: sem ele devolve o valor padrão (comportamento anterior).
convenioSchema.statics.getSessionValue = async function(code, specialty, options = {}) {
  const convenio = await this.findOne({ code: code.toLowerCase(), active: true });
  return resolveConvenioSessionValue(convenio, specialty, options);
};

// Método estático para inicializar convênios padrão
convenioSchema.statics.initializeDefaults = async function() {
  const defaults = [
    { code: 'unimed-anapolis', name: 'Unimed Anápolis', sessionValue: 80 },
    { code: 'unimed-campinas', name: 'Unimed Campinas', sessionValue: 140 },
    { code: 'unimed-goiania', name: 'Unimed Goiânia', sessionValue: 80 }
  ];
  
  for (const conv of defaults) {
    await this.findOneAndUpdate(
      { code: conv.code },
      conv,
      { upsert: true, new: true }
    );
  }
  
  console.log('✅ Convênios padrão inicializados');
};

const Convenio = mongoose.model('Convenio', convenioSchema);

export default Convenio;
