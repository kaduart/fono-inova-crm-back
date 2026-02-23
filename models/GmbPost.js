import mongoose from "mongoose";

/**
 * 📍 Schema para posts do Google Meu Negócio (GMB)
 * Gerencia criação, agendamento e publicação automatizada
 */
const gmbPostSchema = new mongoose.Schema({
  // Conteúdo do post
  title: { type: String, required: true },
  content: { type: String, required: true },
  
  // Tema/assunto do post
  theme: { 
    type: String, 
    required: true,
    index: true 
  },
  
  // Status do post
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'published', 'failed', 'cancelled'],
    default: 'draft',
    index: true
  },
  
  // Agendamento
  scheduledAt: { type: Date, index: true },
  publishedAt: { type: Date },
  
  // Mídia
  mediaUrl: { type: String },
  mediaType: { 
    type: String, 
    enum: ['image', 'video', null],
    default: null 
  },
  
  // CTA (Call to Action)
  ctaType: {
    type: String,
    enum: ['CALL', 'BOOK', 'ORDER', 'SHOP', 'SIGN_UP', 'LEARN_MORE', 'NONE'],
    default: 'CALL'
  },
  ctaUrl: { type: String },
  
  // Resposta da API do Google
  gmbPostId: { type: String },
  gmbAccountId: { type: String },
  gmbLocationId: { type: String },
  
  // Métricas (quando disponíveis)
  metrics: {
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    lastUpdated: { type: Date }
  },
  
  // Geração por IA
  aiGenerated: { type: Boolean, default: true },
  aiModel: { type: String, default: 'claude-sonnet-4-6' },
  aiPrompt: { type: String },
  
  // Erros e retries
  error: { type: String },
  retryCount: { type: Number, default: 0 },
  lastErrorAt: { type: Date },
  
  // Metadados
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publishedBy: { type: String, enum: ['manual', 'cron', 'api'], default: 'manual' },
  
  // Tags para organização
  tags: [{ type: String }],
  
  // Campanha/estratégia
  campaign: { type: String },
  
}, { timestamps: true });

// Índices para consultas comuns
gmbPostSchema.index({ status: 1, scheduledAt: 1 });
gmbPostSchema.index({ status: 1, createdAt: -1 });
gmbPostSchema.index({ theme: 1, status: 1 });
gmbPostSchema.index({ tags: 1 });
gmbPostSchema.index({ gmbPostId: 1 });

// Índice para busca de posts agendados pendentes
gmbPostSchema.index({ 
  status: 1, 
  scheduledAt: 1 
}, {
  partialFilterExpression: { status: 'scheduled' }
});

/**
 * Marca post como publicado
 */
gmbPostSchema.methods.markPublished = function(gmbPostId) {
  this.status = 'published';
  this.publishedAt = new Date();
  this.gmbPostId = gmbPostId;
  return this.save();
};

/**
 * Marca post como falho
 */
gmbPostSchema.methods.markFailed = function(error) {
  this.status = 'failed';
  this.error = error?.slice(0, 1000) || 'Erro desconhecido';
  this.lastErrorAt = new Date();
  this.retryCount = (this.retryCount || 0) + 1;
  return this.save();
};

/**
 * Agenda post para publicação
 */
gmbPostSchema.methods.schedule = function(date) {
  this.status = 'scheduled';
  this.scheduledAt = date || new Date();
  return this.save();
};

/**
 * Cancela post agendado
 */
gmbPostSchema.methods.cancel = function() {
  if (this.status === 'scheduled') {
    this.status = 'cancelled';
    return this.save();
  }
  throw new Error('Apenas posts agendados podem ser cancelados');
};

/**
 * Atualiza métricas
 */
gmbPostSchema.methods.updateMetrics = function(views, clicks) {
  this.metrics.views = views || this.metrics.views;
  this.metrics.clicks = clicks || this.metrics.clicks;
  this.metrics.lastUpdated = new Date();
  return this.save();
};

// Statics para consultas úteis

/**
 * Busca posts agendados para publicação
 */
gmbPostSchema.statics.findScheduledForPublish = function(limit = 10) {
  return this.find({
    status: 'scheduled',
    scheduledAt: { $lte: new Date() }
  })
  .sort({ scheduledAt: 1 })
  .limit(limit);
};

/**
 * Busca posts por período
 */
gmbPostSchema.statics.findByPeriod = function(startDate, endDate, status) {
  const query = {
    createdAt: { $gte: startDate, $lte: endDate }
  };
  if (status) query.status = status;
  return this.find(query).sort({ createdAt: -1 });
};

/**
 * Estatísticas de posts
 */
gmbPostSchema.statics.getStats = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);
  
  const total = await this.countDocuments();
  const publishedThisMonth = await this.countDocuments({
    status: 'published',
    publishedAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
  });
  
  return {
    total,
    byStatus: stats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
    publishedThisMonth
  };
};

export default mongoose.model("GmbPost", gmbPostSchema);
