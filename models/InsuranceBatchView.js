// models/InsuranceBatchView.js
/**
 * InsuranceBatch View Model - CQRS Read Model
 * 
 * Read model otimizado para consultas de lotes de faturamento de convênio.
 * Atualizado via eventos do insuranceOrchestratorWorker.
 * 
 * Fonte de verdade: InsuranceBatch (write model)
 */

import mongoose from 'mongoose';

const batchSessionViewSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  appointmentId: { type: String, required: true },
  guideId: { type: String },
  
  // Valores
  grossAmount: { type: Number, required: true },
  netAmount: { type: Number },
  returnAmount: { type: Number },
  glosaAmount: { type: Number },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'sent', 'processing', 'paid', 'rejected', 'partial'],
    default: 'pending'
  },
  
  // Retorno do convênio
  glosaReason: String,
  protocolNumber: String,
  
  // Datas
  sentAt: Date,
  processedAt: Date
}, { _id: false });

const insuranceBatchViewSchema = new mongoose.Schema({
  // ID do lote original
  batchId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Identificação
  batchNumber: {
    type: String,
    required: true,
    index: true
  },

  // Convênio
  insuranceProvider: {
    type: String,
    required: true,
    index: true
  },

  // Período
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  sentDate: Date,

  // Sessões (denormalizado para leitura rápida)
  sessions: [batchSessionViewSchema],
  totalSessions: { type: Number, default: 0 },

  // Totais
  totalGross: { type: Number, default: 0 },
  totalNet: { type: Number, default: 0 },
  receivedAmount: { type: Number, default: 0 },
  totalGlosa: { type: Number, default: 0 },

  // Status do lote
  status: {
    type: String,
    enum: ['building', 'ready', 'sent', 'processing', 'received', 'rejected', 'closed'],
    default: 'building',
    index: true
  },

  // Documentos
  xmlFile: String,
  returnFile: String,

  // Controle
  processedAt: Date,
  processedBy: String,
  notes: String,
  correlationId: String,

  // Metadados
  createdAt: Date,
  updatedAt: Date,

  // Snapshot
  snapshot: {
    version: { type: Number, default: 1 },
    lastRebuildAt: { type: Date, default: Date.now }
  }

}, {
  timestamps: true,
  collection: 'insurance_batches_view'
});

// ============================================
// ÍNDICES COMPOSTOS
// ============================================

// Busca por convênio e status
insuranceBatchViewSchema.index(
  { insuranceProvider: 1, status: 1, createdAt: -1 },
  { name: 'idx_provider_status' }
);

// Busca por período
insuranceBatchViewSchema.index(
  { startDate: 1, endDate: 1 },
  { name: 'idx_period' }
);

// Busca por status para dashboard
insuranceBatchViewSchema.index(
  { status: 1, updatedAt: -1 },
  { name: 'idx_status_dashboard' }
);

// ============================================
// MÉTODOS ESTÁTICOS
// ============================================

/**
 * Dashboard de convênios - resumo por status
 */
insuranceBatchViewSchema.statics.getDashboard = async function(filters = {}) {
  const { insuranceProvider, startDate, endDate } = filters;

  const match = {};
  if (insuranceProvider) match.insuranceProvider = insuranceProvider;
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  const stats = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalGross: { $sum: '$totalGross' },
        totalNet: { $sum: '$totalNet' },
        receivedAmount: { $sum: '$receivedAmount' },
        totalGlosa: { $sum: '$totalGlosa' }
      }
    }
  ]);

  const byStatus = {};
  stats.forEach(s => {
    byStatus[s._id] = {
      count: s.count,
      totalGross: s.totalGross,
      totalNet: s.totalNet,
      receivedAmount: s.receivedAmount,
      totalGlosa: s.totalGlosa
    };
  });

  // Totais gerais
  const totals = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalBatches: { $sum: 1 },
        totalGross: { $sum: '$totalGross' },
        totalNet: { $sum: '$totalNet' },
        totalReceived: { $sum: '$receivedAmount' },
        totalGlosa: { $sum: '$totalGlosa' }
      }
    }
  ]);

  return {
    byStatus,
    totals: totals[0] || {
      totalBatches: 0,
      totalGross: 0,
      totalNet: 0,
      totalReceived: 0,
      totalGlosa: 0
    }
  };
};

/**
 * Lista lotes com filtros e paginação
 */
insuranceBatchViewSchema.statics.list = async function(options = {}) {
  const {
    page = 1,
    limit = 20,
    status = null,
    insuranceProvider = null,
    startDate = null,
    endDate = null
  } = options;

  const query = {};
  if (status) query.status = status;
  if (insuranceProvider) query.insuranceProvider = insuranceProvider;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const [batches, total] = await Promise.all([
    this.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    this.countDocuments(query)
  ]);

  return {
    batches,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

/**
 * Busca lote por número
 */
insuranceBatchViewSchema.statics.findByNumber = async function(batchNumber) {
  return await this.findOne({ batchNumber }).lean();
};

/**
 * Métricas por convênio
 */
insuranceBatchViewSchema.statics.getMetricsByProvider = async function(startDate, endDate) {
  const match = {
    createdAt: {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    }
  };

  return await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$insuranceProvider',
        totalBatches: { $sum: 1 },
        totalGross: { $sum: '$totalGross' },
        totalNet: { $sum: '$totalNet' },
        totalReceived: { $sum: '$receivedAmount' },
        totalGlosa: { $sum: '$totalGlosa' },
        avgApprovalRate: {
          $avg: {
            $cond: [
              { $gt: ['$totalGross', 0] },
              { $divide: ['$totalNet', '$totalGross'] },
              0
            ]
          }
        }
      }
    },
    { $sort: { totalGross: -1 } }
  ]);
};

const InsuranceBatchView = mongoose.model('InsuranceBatchView', insuranceBatchViewSchema);

export default InsuranceBatchView;
