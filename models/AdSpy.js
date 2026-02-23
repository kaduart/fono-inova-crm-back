/**
 * 🔍 Model para anúncios salvos do Spy
 */

import mongoose from 'mongoose';

const adSpySchema = new mongoose.Schema({
  adId: {
    type: String,
    required: true,
    unique: true
  },
  pageName: {
    type: String,
    required: true
  },
  adText: {
    type: String,
    required: true
  },
  adTitle: {
    type: String,
    default: ''
  },
  adCaption: {
    type: String,
    default: ''
  },
  thumbnailUrl: {
    type: String,
    default: null
  },
  snapshotUrl: {
    type: String,
    required: true
  },
  keyword: {
    type: String,
    required: true
  },
  especialidade: {
    type: String,
    enum: ['fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'fisioterapia', 'musicoterapia', 'geral'],
    default: 'geral'
  },
  funil: {
    type: String,
    enum: ['top', 'middle', 'bottom'],
    default: 'top'
  },
  daysActive: {
    type: Number,
    default: 0
  },
  impressions: {
    type: Number,
    default: 0
  },
  spend: {
    type: Number,
    default: 0
  },
  objective: {
    type: String,
    default: null
  },
  // Análise IA
  analysis: {
    gancho: String,
    estrutura: String,
    cta: String,
    porqueConverte: String,
    pontosFracos: String,
    tomDeVoz: String,
    elementosVisuaisSugeridos: String
  },
  // Versão adaptada
  adaptedPost: {
    type: String,
    default: null
  },
  adaptadoPara: {
    type: String,
    enum: ['instagram', 'facebook', 'gmb', 'video', 'ads'],
    default: null
  },
  // Status
  saved: {
    type: Boolean,
    default: true
  },
  // Relacionamentos
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Índices
adSpySchema.index({ especialidade: 1 });
adSpySchema.index({ keyword: 1 });
adSpySchema.index({ daysActive: -1 });
adSpySchema.index({ saved: 1 });
adSpySchema.index({ createdBy: 1 });

const AdSpy = mongoose.model('AdSpy', adSpySchema);

export default AdSpy;
