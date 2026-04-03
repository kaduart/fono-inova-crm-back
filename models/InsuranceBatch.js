// models/InsuranceBatch.js
// Migration 2: Lotes de Faturamento Convênio

import mongoose from 'mongoose';

const insuranceBatchSessionSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  guide: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceGuide' },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  protocolItemId: { type: String },
  
  // Valores
  grossAmount: { type: Number, required: true },
  netAmount: { type: Number },
  
  // Status no lote
  status: {
    type: String,
    enum: ['pending', 'sent', 'processing', 'paid', 'rejected', 'partial'],
    default: 'pending'
  },
  
  // Retorno do convênio
  returnAmount: Number,
  glosaAmount: Number,
  glosaReason: String,
  protocolNumber: String,
  
  // Controle
  sentAt: Date,
  processedAt: Date,
  updatedAt: { type: Date, default: Date.now }
}, { _id: true });

const insuranceBatchSchema = new mongoose.Schema({
  // Identificação
  batchNumber: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  
  // Convênio
  insuranceProvider: { type: String, required: true },
  
  // Período
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  sentDate: Date,
  
  // Sessões incluídas
  sessions: [insuranceBatchSessionSchema],
  
  // Totais
  totalGross: { type: Number, default: 0 },
  totalNet: { type: Number, default: 0 },
  totalSessions: { type: Number, default: 0 },
  
  // Retorno do convênio
  receivedAmount: { type: Number, default: 0 },
  totalGlosa: { type: Number, default: 0 },
  
  // Status
  status: {
    type: String,
    enum: ['building', 'ready', 'sent', 'processing', 'received', 'rejected', 'closed'],
    default: 'building'
  },
  
  // Documentos
  xmlFile: String,
  returnFile: String,
  
  // Controle
  processedAt: Date,
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes: String,
  
  // Event-Driven
  correlationId: String
}, {
  timestamps: true
});

// Índices
insuranceBatchSchema.index({ insuranceProvider: 1, status: 1 });
insuranceBatchSchema.index({ startDate: 1, endDate: 1 });
insuranceBatchSchema.index({ status: 1, createdAt: 1 });
insuranceBatchSchema.index({ 'sessions.session': 1 });
insuranceBatchSchema.index({ 'sessions.appointment': 1 });

// Virtual: sessões pendentes
insuranceBatchSchema.virtual('pendingSessions').get(function() {
  return this.sessions.filter(s => s.status === 'pending').length;
});

// Virtual: valor a receber
insuranceBatchSchema.virtual('expectedAmount').get(function() {
  return this.totalGross - this.totalGlosa;
});

const InsuranceBatch = mongoose.model('InsuranceBatch', insuranceBatchSchema);
export default InsuranceBatch;
