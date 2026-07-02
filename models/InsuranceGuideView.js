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
import { GuideLifecycleService } from '../services/guideLifecycle/GuideLifecycleService.js';

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
 * Busca guias elegíveis para agendamento usando lifecycle.
 */
insuranceGuideViewSchema.statics.findValid = async function(patientId, specialty, date = new Date()) {
  const candidates = await this.find({
    patientId,
    specialty: specialty.toLowerCase().trim(),
    status: { $in: ['active', 'linked'] }
  })
    .sort({ expiresAt: 1 })
    .lean();

  for (const guide of candidates) {
    const lifecycle = await GuideLifecycleService.evaluate(guide, date);
    if (lifecycle.eligibility.canSchedule) {
      return guide;
    }
  }

  return null;
};

/**
 * Retorna saldo agregado de guias elegíveis segundo o lifecycle.
 */
insuranceGuideViewSchema.statics.getBalance = async function(patientId, specialty = null) {
  const now = new Date();
  const match = {
    patientId,
    status: { $in: ['active', 'linked'] }
  };

  if (specialty) {
    match.specialty = specialty.toLowerCase().trim();
  }

  const candidates = await this.find(match)
    .sort({ expiresAt: 1 })
    .lean();

  const usableGuides = [];
  for (const guide of candidates) {
    const lifecycle = await GuideLifecycleService.evaluate(guide, now);
    if (lifecycle.eligibility.canSchedule || lifecycle.eligibility.canBill) {
      usableGuides.push({ guide, lifecycle });
    }
  }

  const total = usableGuides.reduce((sum, { guide }) => sum + (guide.totalSessions || 0), 0);
  const used = usableGuides.reduce((sum, { guide }) => sum + (guide.usedSessions || 0), 0);
  const remaining = usableGuides.reduce((sum, { guide }) => sum + (guide.remainingSessions || 0), 0);

  return {
    total,
    used,
    remaining,
    guides: usableGuides.map(({ guide, lifecycle }) => ({
      id: guide._id,
      guideId: guide.guideId,
      number: guide.number,
      specialty: guide.specialty,
      insurance: guide.insurance,
      total: guide.totalSessions,
      used: guide.usedSessions,
      remaining: guide.remainingSessions,
      expiresAt: guide.expiresAt,
      lifecycle
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
