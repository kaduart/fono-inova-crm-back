// models/InsuranceGuideView.js
/**
 * InsuranceGuide View Model - CQRS Read Model
 * 
 * Read model otimizado para consultas de guias de convênio.
 * Atualizado via eventos (event-driven projection).
 * 
 * Fonte de verdade: InsuranceGuide (write model)
 */

import mongoose from 'mongoose';

const insuranceGuideViewSchema = new mongoose.Schema({
  // ID da guia original (write model)
  guideId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Dados da guia
  number: {
    type: String,
    required: true,
    index: true
  },

  patientId: {
    type: String,
    required: true,
    index: true
  },

  patientName: String,
  patientCpf: String,

  specialty: {
    type: String,
    required: true,
    index: true
  },

  insurance: {
    type: String,
    required: true,
    index: true
  },

  // Controle de sessões
  totalSessions: {
    type: Number,
    required: true,
    min: 1
  },

  usedSessions: {
    type: Number,
    default: 0,
    min: 0
  },

  remainingSessions: {
    type: Number,
    default: 0
  },

  // Status e validade
  status: {
    type: String,
    enum: ['active', 'exhausted', 'expired', 'cancelled'],
    default: 'active',
    index: true
  },

  expiresAt: {
    type: Date,
    required: true,
    index: true
  },

  isValid: {
    type: Boolean,
    default: true
  },

  // Relacionamentos
  packageId: {
    type: String,
    default: null,
    index: true
  },

  // Metadados
  createdBy: String,
  createdAt: Date,
  updatedAt: Date,

  // Snapshot version para controle
  snapshot: {
    version: { type: Number, default: 1 },
    lastRebuildAt: { type: Date, default: Date.now }
  }

}, {
  timestamps: true,
  collection: 'insurance_guides_view'
});

// ============================================
// ÍNDICES COMPOSTOS (otimização de queries)
// ============================================

// Busca de guias válidas para agendamento
insuranceGuideViewSchema.index(
  { patientId: 1, specialty: 1, status: 1, expiresAt: 1 },
  { name: 'idx_valid_guide_lookup' }
);

// Busca por convênio
insuranceGuideViewSchema.index(
  { insurance: 1, status: 1 },
  { name: 'idx_insurance_status' }
);

// Busca por número de guia
insuranceGuideViewSchema.index(
  { number: 1 },
  { name: 'idx_guide_number' }
);

// ============================================
// MÉTODOS ESTÁTICOS (queries otimizadas)
// ============================================

/**
 * Busca guias válidas para agendamento
 */
insuranceGuideViewSchema.statics.findValid = async function(patientId, specialty, date = new Date()) {
  return await this.find({
    patientId,
    specialty: specialty.toLowerCase().trim(),
    status: 'active',
    expiresAt: { $gte: date },
    $expr: { $lt: ['$usedSessions', '$totalSessions'] }
  })
    .sort({ expiresAt: 1 }) // FIFO: primeira a vencer
    .lean();
};

/**
 * Retorna saldo agregado de guias ativas
 */
insuranceGuideViewSchema.statics.getBalance = async function(patientId, specialty = null) {
  const match = {
    patientId,
    status: 'active',
    expiresAt: { $gte: new Date() }
  };

  if (specialty) {
    match.specialty = specialty.toLowerCase().trim();
  }

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: '$totalSessions' },
        used: { $sum: '$usedSessions' },
        remaining: { $sum: '$remainingSessions' },
        guides: { $push: '$$ROOT' }
      }
    }
  ]);

  if (result.length === 0) {
    return { total: 0, used: 0, remaining: 0, guides: [] };
  }

  return {
    total: result[0].total,
    used: result[0].used,
    remaining: result[0].remaining,
    guides: result[0].guides.map(g => ({
      id: g._id,
      guideId: g.guideId,
      number: g.number,
      specialty: g.specialty,
      insurance: g.insurance,
      total: g.totalSessions,
      used: g.usedSessions,
      remaining: g.remainingSessions,
      expiresAt: g.expiresAt
    }))
  };
};

/**
 * Lista guias por status com paginação
 */
insuranceGuideViewSchema.statics.listByStatus = async function(status, options = {}) {
  const { page = 1, limit = 20, patientId = null, insurance = null } = options;

  const query = { status };
  if (patientId) query.patientId = patientId;
  if (insurance) query.insurance = insurance.toLowerCase();

  const [guides, total] = await Promise.all([
    this.find(query)
      .sort({ expiresAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    this.countDocuments(query)
  ]);

  return {
    guides,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

const InsuranceGuideView = mongoose.model('InsuranceGuideView', insuranceGuideViewSchema);

export default InsuranceGuideView;
