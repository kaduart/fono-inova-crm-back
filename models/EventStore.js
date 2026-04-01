// models/EventStore.js
// Event Store - Persistência imutável de todos os eventos do sistema
// 
// PRINCÍPIOS:
// 1. APPEND-ONLY: Nunca deleta ou atualiza
// 2. IMMUTABLE: Uma vez salvo, não muda
// 3. ORDERED: Ordem de ocorrência preservada
// 4. QUERYABLE: Busca por aggregate, tipo, período

import mongoose from 'mongoose';

const eventMetadataSchema = new mongoose.Schema({
  // Rastreabilidade
  correlationId: { type: String, index: true },
  causationId: { type: String }, // ID do evento que causou este
  
  // Origem
  source: { type: String, default: 'unknown' }, // nome do serviço
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userEmail: { type: String },
  
  // Contexto HTTP
  ip: { type: String },
  userAgent: { type: String },
  
  // Feature flags ativas no momento
  featureFlags: { type: Map, of: Boolean },
  
  // Timestamp do client (se diferente do server)
  clientTimestamp: Date
}, { _id: false });

const eventStoreSchema = new mongoose.Schema({
  // Identificação única do evento
  eventId: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  
  // Tipo do evento (ex: APPOINTMENT_CREATED)
  eventType: { 
    type: String, 
    required: true,
    index: true 
  },
  
  // Versão do schema do evento
  eventVersion: { 
    type: Number, 
    default: 1 
  },
  
  // Aggregate (entidade) associada
  aggregateType: { 
    type: String, 
    required: true,
    index: true,
    enum: ['appointment', 'lead', 'patient', 'payment', 'invoice', 'package', 'followup', 'notification', 'system', 'totals', 'daily_closing']
  },
  
  aggregateId: { 
    type: String, 
    required: true,
    index: true 
  },
  
  // Sequência do evento no aggregate (para ordenação garantida)
  sequenceNumber: { 
    type: Number,
    index: true 
  },
  
  // Payload do evento (dados)
  payload: { 
    type: mongoose.Schema.Types.Mixed, 
    required: true 
  },
  
  // Metadados
  metadata: { 
    type: eventMetadataSchema, 
    default: {} 
  },
  
  // Status de processamento
  status: {
    type: String,
    enum: ['pending', 'processing', 'processed', 'failed', 'dead_letter'],
    default: 'pending',
    index: true
  },
  
  // Controle de processamento
  processedAt: Date,
  processedBy: String, // nome do worker que processou
  attempts: { type: Number, default: 0 },
  
  // Erro (se falhou)
  error: {
    message: String,
    stack: String,
    code: String
  },
  
  // Idempotência - chave única para deduplicação
  idempotencyKey: { 
    type: String, 
    index: true,
    sparse: true // permite null
  },
  
  // TTL para eventos antigos (opcional - limpar automaticamente)
  expiresAt: Date
}, {
  timestamps: { createdAt: true, updatedAt: false }, // Só createdAt (imutável)
  collection: 'eventstore' // nome explícito da collection
});

// ============ ÍNDICES ============

// Query por aggregate (replay)
eventStoreSchema.index({ aggregateType: 1, aggregateId: 1, sequenceNumber: 1 });

// Query por tipo e período (analytics)
eventStoreSchema.index({ eventType: 1, createdAt: -1 });

// Query por status (processamento pendente)
eventStoreSchema.index({ status: 1, createdAt: 1 });

// Query por correlation (rastreabilidade)
eventStoreSchema.index({ 'metadata.correlationId': 1, createdAt: 1 });

// TTL index (limpa eventos antigos automaticamente)
eventStoreSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ============ MÉTODOS ESTÁTICOS ============

/**
 * Busca eventos de um aggregate (para replay)
 */
eventStoreSchema.statics.findByAggregate = async function(aggregateType, aggregateId, options = {}) {
  const { fromSequence = 0, limit = 1000, status = null } = options;
  
  const query = { 
    aggregateType, 
    aggregateId,
    sequenceNumber: { $gte: fromSequence }
  };
  
  if (status) {
    query.status = status;
  }
  
  return this.find(query)
    .sort({ sequenceNumber: 1, createdAt: 1 })
    .limit(limit)
    .lean();
};

/**
 * Busca último evento de um aggregate (para sequence number)
 */
eventStoreSchema.statics.findLastByAggregate = async function(aggregateType, aggregateId) {
  return this.findOne({ aggregateType, aggregateId })
    .sort({ sequenceNumber: -1, createdAt: -1 })
    .lean();
};

/**
 * Verifica se evento já foi processado (idempotência)
 */
eventStoreSchema.statics.isProcessed = async function(idempotencyKey) {
  if (!idempotencyKey) return false;
  
  const event = await this.findOne({ 
    idempotencyKey,
    status: { $in: ['processed', 'processing'] }
  });
  
  return !!event;
};

/**
 * Busca eventos pendentes para reprocessamento
 */
eventStoreSchema.statics.findPending = async function(options = {}) {
  const { limit = 100, olderThanMinutes = 5 } = options;
  const cutoffDate = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  
  return this.find({
    status: { $in: ['pending', 'failed'] },
    createdAt: { $lte: cutoffDate },
    attempts: { $lt: 5 }
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
};

/**
 * Estatísticas do event store
 */
eventStoreSchema.statics.getStats = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: {
          status: '$status',
          eventType: '$eventType'
        },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.status',
        types: {
          $push: {
            eventType: '$_id.eventType',
            count: '$count'
          }
        },
        total: { $sum: '$count' }
      }
    }
  ]);
  
  return stats;
};

// ============ MÉTODOS DE INSTÂNCIA ============

/**
 * Marca evento como processado
 */
eventStoreSchema.methods.markProcessed = async function(workerName) {
  this.status = 'processed';
  this.processedAt = new Date();
  this.processedBy = workerName;
  return this.save();
};

/**
 * Marca evento como falhou
 */
eventStoreSchema.methods.markFailed = async function(error) {
  this.status = 'failed';
  this.attempts += 1;
  this.error = {
    message: error.message,
    stack: error.stack,
    code: error.code
  };
  return this.save();
};

/**
 * Marca evento como dead letter (não vai tentar mais)
 */
eventStoreSchema.methods.markDeadLetter = async function(error) {
  this.status = 'dead_letter';
  this.error = {
    message: error.message,
    stack: error.stack,
    code: error.code
  };
  return this.save();
};

// ============ PRE-SAVE ============

// Garante sequence number antes de salvar
eventStoreSchema.pre('save', async function(next) {
  if (this.isNew && !this.sequenceNumber) {
    const lastEvent = await this.constructor.findLastByAggregate(
      this.aggregateType, 
      this.aggregateId
    );
    this.sequenceNumber = (lastEvent?.sequenceNumber || 0) + 1;
  }
  next();
});

const EventStore = mongoose.model('EventStore', eventStoreSchema);

export default EventStore;
