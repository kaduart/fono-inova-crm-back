import mongoose from "mongoose";

/**
 * 📍 Schema para posts do Google Meu Negócio (GMB)
 * VERSÃO ASSISTIDA: Sistema gera, humano publica
 */
const gmbPostSchema = new mongoose.Schema({
  // Conteúdo do post
  title: { type: String, required: true },
  content: { type: String, required: true },
  
  // Tipo de post (estratégia)
  type: {
    type: String,
    enum: ['daily', 'offer', 'review', 'institutional', 'educational', 'vaga'],
    default: 'daily',
    index: true
  },
  
  // Tema/assunto do post
  theme: { 
    type: String, 
    required: true,
    index: true 
  },
  
  // Status do post (assistido)
  status: {
    type: String,
    enum: ['draft', 'ready', 'scheduled', 'published', 'failed', 'cancelled', 'processing'],
    default: 'draft',
    index: true
  },
  
  // Status do processamento (async)
  processingStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: null
  },
  errorMessage: { type: String },
  
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
  imageProvider: { 
    type: String,
    description: 'Provedor da imagem (fal.ai, imagebank, etc)'
  },
  
  // CTA (Call to Action)
  ctaType: {
    type: String,
    enum: ['CALL', 'BOOK', 'ORDER', 'SHOP', 'SIGN_UP', 'LEARN_MORE', 'NONE'],
    default: 'CALL'
  },
  ctaUrl: { type: String },
  
  // 🎯 Landing Page vinculada
  landingPageRef: { 
    type: String, 
    index: true,
    description: 'Slug da landing page vinculada'
  },
  landingPageUrl: { 
    type: String,
    description: 'URL completa da landing page'
  },
  
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
  
  // 🎯 Campos do Publisher Assistido
  assistData: {
    // URL direta do painel do Google
    gmbUrl: { type: String },
    // Conteúdo formatado para copiar
    copyText: { type: String },
    // Indica se já foi copiado
    copiedAt: { type: Date },
    // Quem publicou manualmente
    publishedByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Data prevista de publicação
    scheduledFor: { type: Date }
  },
  
  // Tom de voz usado na geração
  tone: {
    type: String,
    enum: ['emotional', 'educativo', 'inspiracional', 'bastidores'],
    default: 'emotional'
  },

  // Score de qualidade gerado pela IA
  qualityScore: {
    clareza: { type: Number },
    impacto_emocional: { type: Number },
    cta: { type: Number },
    score_geral: { type: Number },
    ponto_forte: { type: String },
    sugestao: { type: String }
  },

  // Prioridade/Score do post (para IA)
  priority: { type: Number, default: 0 },
  
  // Fonte de dados (agenda, vendas, etc)
  dataSource: {
    type: { type: String, enum: ['agenda', 'vendas', 'avaliacoes', 'vagas', 'manual'] },
    details: { type: String }
  },
  
  // Geração por IA
  aiGenerated: { type: Boolean, default: true },
  aiModel: { type: String, default: 'claude-sonnet-4-6' },
  aiPrompt: { type: String },
  // 🖼️ Qual IA gerou a imagem (fal-flux-pro, hf-flux-dev, pollinations-flux)
  imageProvider: { type: String, default: null },
  
  // Erros e retries
  error: { type: String },
  retryCount: { type: Number, default: 0 },
  lastErrorAt: { type: Date },
  jobId: { type: String },
  
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
gmbPostSchema.index({ status: 1, type: 1, createdAt: -1 });
gmbPostSchema.index({ theme: 1, status: 1 });
gmbPostSchema.index({ tags: 1 });
gmbPostSchema.index({ gmbPostId: 1 });

// 🚨 Índice ÚNICO: Impede 2 posts do mesmo tipo no mesmo dia
gmbPostSchema.index({ 
  type: 1, 
  createdAt: 1 
}, {
  unique: true,
  partialFilterExpression: { 
    status: { $in: ['ready', 'published'] },
    type: { $in: ['daily', 'vaga'] }
  }
});

// Índice para busca de posts agendados pendentes
gmbPostSchema.index({ 
  status: 1, 
  scheduledAt: 1 
}, {
  partialFilterExpression: { status: 'scheduled' }
});

// Índice para posts do dia (evita duplicidade)
gmbPostSchema.index({
  'assistData.scheduledFor': 1,
  status: 1
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
 * 🚨 Verifica se já existe post do tipo hoje
 */
gmbPostSchema.statics.existsToday = async function(type) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  
  const count = await this.countDocuments({
    type,
    createdAt: { $gte: startOfDay, $lte: endOfDay },
    status: { $in: ['ready', 'published'] }
  });
  
  return count > 0;
};

/**
 * Busca posts prontos para publicar (assistido)
 */
gmbPostSchema.statics.findReadyForPublish = function(limit = 5) {
  return this.find({ status: 'ready' })
    .sort({ 'assistData.scheduledFor': 1, priority: -1 })
    .limit(limit);
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
