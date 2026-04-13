// back/models/PackagesView.js
/**
 * PackagesView - Read Model CQRS para Pacotes V2
 * 
 * Características:
 * - Snapshot materializado (não é source of truth)
 * - Índices otimizados para queries frequentes
 * - TTL automático para dados antigos
 * - Versionado para consistência
 */

import mongoose from 'mongoose';

const packagesViewSchema = new mongoose.Schema({
  // 🔗 Identificação
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    unique: true,
    index: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },

  // 📦 Dados do Pacote
  type: {
    type: String,
    enum: ['therapy', 'convenio', 'liminar', 'particular'],
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'finished', 'canceled', 'canceling'],
    default: 'active',
    index: true
  },
  specialty: String,
  sessionType: String,

  // 📊 Métricas de Sessões (ESSENCIAL)
  totalSessions: {
    type: Number,
    default: 0
  },
  sessionsDone: {
    type: Number,
    default: 0
  },
  sessionsUsed: {
    type: Number,
    default: 0
  },
  sessionsRemaining: {
    type: Number,
    default: 0
  },
  sessionsCanceled: {
    type: Number,
    default: 0
  },

  // 💰 Financeiro
  sessionValue: Number,
  totalValue: Number,
  totalPaid: Number,
  balance: Number,
  financialStatus: {
    type: String,
    enum: ['paid', 'partially_paid', 'unpaid', 'pending'],
    default: 'unpaid'
  },
  
  // ⚖️ Liminar (campos específicos)
  liminarTotalCredit: Number,
  liminarCreditBalance: Number,
  recognizedRevenue: Number,
  liminarProcessNumber: String,
  liminarCourt: String,
  liminarMode: String,
  
  // 🏥 Convênio (campos específicos)
  insuranceGrossAmount: Number,
  insuranceBillingStatus: String,

  // 📅 Datas
  startDate: Date,
  endDate: Date,
  expiresAt: {
    type: Date,
    index: true
  },

  // 🔗 Relacionamentos (denormalizados)
  insuranceGuideId: mongoose.Schema.Types.ObjectId,
  insuranceProvider: String,

  // 📋 Sessões (resumo)
  sessions: [{
    sessionId: mongoose.Schema.Types.ObjectId,
    appointmentId: mongoose.Schema.Types.ObjectId,  // 🔗 Link para o agendamento
    date: String,
    time: String,
    status: String,
    isPaid: Boolean
  }],

  // 📈 Metadados do Snapshot
  snapshot: {
    version: {
      type: Number,
      default: 1
    },
    calculatedAt: {
      type: Date,
      default: Date.now
    },
    ttl: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) // 90 dias
    },
    isStale: {
      type: Boolean,
      default: false
    }
  },

  // 🔍 Campos de Busca
  searchFields: {
    patientName: String,
    doctorName: String
  }
}, {
  timestamps: true,
  collection: 'packages_view'
});

// ============================================
// ÍNDICES COMPOSTOS (performance crítica)
// ============================================

// Busca por paciente + status (mais comum)
packagesViewSchema.index({ patientId: 1, status: 1, 'snapshot.calculatedAt': -1 });

// Busca por doutor + status
packagesViewSchema.index({ doctorId: 1, status: 1, 'snapshot.calculatedAt': -1 });

// Busca por tipo + status (relatórios)
packagesViewSchema.index({ type: 1, status: 1, 'snapshot.calculatedAt': -1 });

// TTL automático para limpeza
packagesViewSchema.index({ 'snapshot.ttl': 1 }, { expireAfterSeconds: 0 });

// ============================================
// MÉTODOS ESTÁTICOS
// ============================================

packagesViewSchema.statics.findByPatient = async function(patientId, options = {}) {
  const { status, limit = 50, skip = 0 } = options;
  
  const query = { patientId };
  if (status) query.status = status;
  
  return this.find(query)
    .sort({ 'snapshot.calculatedAt': -1 })
    .skip(skip)
    .limit(limit)
    .lean();
};

packagesViewSchema.statics.findActiveByPatient = async function(patientId) {
  return this.find({
    patientId,
    status: { $in: ['active', 'finished'] }
  })
    .sort({ 'snapshot.calculatedAt': -1 })
    .lean();
};

packagesViewSchema.statics.getStats = async function(patientId) {
  const result = await this.aggregate([
    { $match: { patientId: new mongoose.Types.ObjectId(patientId) } },
    {
      $group: {
        _id: null,
        totalPackages: { $sum: 1 },
        activePackages: {
          $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
        },
        totalSessions: { $sum: '$totalSessions' },
        totalUsed: { $sum: '$sessionsUsed' },
        totalRemaining: { $sum: '$sessionsRemaining' }
      }
    }
  ]);
  
  return result[0] || {
    totalPackages: 0,
    activePackages: 0,
    totalSessions: 0,
    totalUsed: 0,
    totalRemaining: 0
  };
};

// ============================================
// MÉTODOS DE INSTÂNCIA
// ============================================

packagesViewSchema.methods.markAsStale = async function() {
  this.snapshot.isStale = true;
  return this.save();
};

packagesViewSchema.methods.refreshSnapshot = async function() {
  this.snapshot.version += 1;
  this.snapshot.calculatedAt = new Date();
  this.snapshot.ttl = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  this.snapshot.isStale = false;
  return this.save();
};

// ============================================
// MIDDLEWARE
// ============================================

// Auto-atualiza sessionsRemaining antes de salvar
packagesViewSchema.pre('save', function(next) {
  this.sessionsRemaining = this.totalSessions - this.sessionsUsed - this.sessionsCanceled;
  if (this.sessionsRemaining < 0) this.sessionsRemaining = 0;
  next();
});

const PackagesView = mongoose.model('PackagesView', packagesViewSchema);

export default PackagesView;
