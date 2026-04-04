// back/models/PatientsView.js
/**
 * PatientsView - READ MODEL (CQRS)
 * 
 * Snapshot otimizado para leitura.
 * Dados desnormalizados, pré-calculados, indexados.
 * NÃO é o modelo de domínio - é a PROJEÇÃO para queries.
 */

import mongoose from 'mongoose';

const patientsViewSchema = new mongoose.Schema({
  // 🔗 Identificação
  patientId: { 
    type: mongoose.Schema.Types.ObjectId, 
    required: true, 
    unique: true,
    index: true 
  },
  
  // 👤 Dados básicos (denormalizados do Patient)
  fullName: { type: String, required: true, index: true },
  normalizedName: { type: String, required: true, index: true }, // para busca accent-insensitive
  dateOfBirth: { type: Date },
  phone: { type: String, index: true },
  phoneDigits: { type: String, index: true }, // apenas números para busca
  email: { type: String, lowercase: true },
  cpf: { type: String, index: true },
  cpfDigits: { type: String, index: true }, // apenas números
  
  // 🏥 Dados clínicos
  mainComplaint: { type: String },
  healthPlan: {
    name: { type: String },
    policyNumber: { type: String }
  },
  
  // 👨‍⚕️ Vínculo
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  doctorName: { type: String, index: true },
  specialty: { type: String, index: true },
  
  // 📊 Métricas pré-calculadas (ESSENCIAL)
  stats: {
    totalAppointments: { type: Number, default: 0 },
    totalCompleted: { type: Number, default: 0 },
    totalCanceled: { type: Number, default: 0 },
    totalNoShow: { type: Number, default: 0 },
    
    totalSessions: { type: Number, default: 0 },
    totalPackages: { type: Number, default: 0 },
    
    totalRevenue: { type: Number, default: 0 }, // valor total pago
    totalPending: { type: Number, default: 0 }, // valor em aberto
    
    firstAppointmentDate: { type: Date },
    lastAppointmentDate: { type: Date },
    nextAppointmentDate: { type: Date }
  },
  
  // 📅 Último/Próximo agendamento (denormalizado)
  lastAppointment: {
    id: { type: mongoose.Schema.Types.ObjectId },
    date: { 
      type: Date, // Date
      set: function(v) {
        if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const [ano, mes, dia] = v.split('-').map(Number);
          return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
        }
        return v;
      }
    },
    time: { type: String }, // HH:mm
    status: { type: String },
    serviceType: { type: String },
    doctorName: { type: String }
  },
  
  nextAppointment: {
    id: { type: mongoose.Schema.Types.ObjectId },
    date: { 
      type: Date,
      set: function(v) {
        if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const [ano, mes, dia] = v.split('-').map(Number);
          return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
        }
        return v;
      }
    },
    time: { type: String },
    status: { type: String },
    serviceType: { type: String },
    doctorName: { type: String }
  },
  
  // 💰 Saldo (denormalizado do PatientBalance)
  balance: {
    current: { type: Number, default: 0 },
    lastUpdated: { type: Date }
  },
  
  // 🏷️ Tags/Categorização
  tags: [{ type: String, index: true }],
  
  // 📊 Status do paciente
  status: { 
    type: String, 
    enum: ['active', 'inactive', 'prospect', 'churned'],
    default: 'active',
    index: true
  },
  
  // 🔄 Metadados do snapshot
  snapshot: {
    version: { type: Number, default: 1 },
    calculatedAt: { type: Date, default: Date.now },
    ttl: { type: Date }, // data de expiração
    isStale: { type: Boolean, default: false }
  }
}, {
  timestamps: true,
  collection: 'patients_view'
});

// ============================================
// ÍNDICES Otimizados para Queries de Tela
// ============================================

// Busca por nome (accent-insensitive já no normalizedName)
patientsViewSchema.index({ normalizedName: 'text', fullName: 'text' });

// Busca por telefone/CPF (apenas dígitos)
patientsViewSchema.index({ phoneDigits: 1 });
patientsViewSchema.index({ cpfDigits: 1 });

// Listagem por doutor + ordenação
patientsViewSchema.index({ doctorId: 1, 'stats.lastAppointmentDate': -1 });

// Listagem por especialidade
patientsViewSchema.index({ specialty: 1, status: 1 });

// Pacientes ativos ordenados por última visita
patientsViewSchema.index({ status: 1, 'stats.lastAppointmentDate': -1 });

// TTL automático para limpar snapshots antigos (90 dias)
patientsViewSchema.index({ 'snapshot.ttl': 1 }, { expireAfterSeconds: 0 });

// ============================================
// MÉTODOS ESTÁTICOS (Query otimizada)
// ============================================

/**
 * Busca rápida por termo (nome, telefone ou CPF)
 */
patientsViewSchema.statics.quickSearch = async function(searchTerm, options = {}) {
  const { 
    limit = 50, 
    skip = 0, 
    doctorId = null,
    status = null 
  } = options;
  
  let query = {};
  
  if (searchTerm && searchTerm.trim()) {
    const term = searchTerm.trim();
    const digits = term.replace(/\D/g, '');
    
    // Normaliza para busca accent-insensitive
    const normalized = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    
    const orConditions = [
      { normalizedName: { $regex: normalized, $options: 'i' } },
      { fullName: { $regex: term, $options: 'i' } }
    ];
    
    if (digits) {
      orConditions.push({ phoneDigits: { $regex: digits } });
      orConditions.push({ cpfDigits: { $regex: digits } });
    }
    
    query.$or = orConditions;
  }
  
  if (doctorId) query.doctorId = doctorId;
  if (status) query.status = status;
  
  const [patients, total] = await Promise.all([
    this.find(query)
      .select('-__v -snapshot.ttl') // exclui campos internos
      .sort({ 'stats.lastAppointmentDate': -1, fullName: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    this.countDocuments(query)
  ]);
  
  return { patients, total, limit, skip };
};

/**
 * Obter view completa de um paciente
 */
patientsViewSchema.statics.getFullView = async function(patientId) {
  const view = await this.findOne({ patientId }).lean();
  
  if (!view) {
    return null;
  }
  
  // Verifica se está stale (> 5 minutos)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  if (view.snapshot.calculatedAt < fiveMinutesAgo) {
    view.snapshot.isStale = true;
  }
  
  return view;
};

/**
 * Listar pacientes por status com paginação
 */
patientsViewSchema.statics.listByStatus = async function(status, options = {}) {
  const { limit = 50, skip = 0, sortBy = 'stats.lastAppointmentDate' } = options;
  
  return await this.find({ status })
    .sort({ [sortBy]: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
};

/**
 * Dashboard: métricas agregadas
 */
patientsViewSchema.statics.getDashboardStats = async function(doctorId = null) {
  const matchStage = doctorId ? { doctorId: new mongoose.Types.ObjectId(doctorId) } : {};
  
  return await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalPatients: { $sum: 1 },
        activePatients: { 
          $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
        },
        totalRevenue: { $sum: '$stats.totalRevenue' },
        totalPending: { $sum: '$stats.totalPending' },
        avgSessionsPerPatient: { $avg: '$stats.totalSessions' }
      }
    }
  ]);
};

const PatientsView = mongoose.model('PatientsView', patientsViewSchema);

export default PatientsView;
