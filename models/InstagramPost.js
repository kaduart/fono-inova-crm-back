/**
 * 📸 Model para Posts do Instagram
 */

import mongoose from 'mongoose';

const instagramPostSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  // 🎯 Headline curta para imagem (estilo Fono Inova)
  headline: {
    type: String,
    default: null
  },
  // 📝 Subheadline (frase complementar na imagem)
  subheadline: {
    type: String,
    default: null
  },
  // 📝 Legenda completa (SEO + CTA)
  caption: {
    type: String,
    default: null
  },
  content: {
    type: String,
    required: true
  },
  mediaUrl: {
    type: String,
    default: null
  },
  mediaType: {
    type: String,
    enum: ['image', 'video', 'carousel'],
    default: 'image'
  },
  theme: {
    type: String,
    required: true
  },
  funnelStage: {
    type: String,
    enum: ['top', 'middle', 'bottom'],
    default: 'top'
  },
  // 🎯 Tipo de post (50/50 estratégia)
  postType: {
    type: String,
    enum: ['lead', 'branding'],
    default: 'branding'
  },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'published', 'failed', 'processing'],
    default: 'draft'
  },
  processingStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: null
  },
  errorMessage: { type: String },
  jobId: { type: String },
  scheduledAt: {
    type: Date,
    default: null
  },
  publishedAt: {
    type: Date,
    default: null
  },
  instagramPostId: {
    type: String,
    default: null
  },
  aiGenerated: {
    type: Boolean,
    default: false
  },
  aiModel: {
    type: String,
    default: null
  },
  // 🖼️ Qual IA gerou a imagem (fal-flux-pro, hf-flux-dev, pollinations-flux)
  imageProvider: {
    type: String,
    default: null
  },
  // 🎨 Layout utilizado (hero_banner_curva, dual_screen_psico, etc)
  layoutId: {
    type: String,
    default: null,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // 📊 Metadados da estratégia
  metadata: {
    headlineStrategy: { type: String, default: null },
    keywordsMatched: [{ type: String }],
    customTheme: { type: String, default: null }
  }
}, {
  timestamps: true
});

// Índices
instagramPostSchema.index({ status: 1, scheduledAt: 1 });
instagramPostSchema.index({ theme: 1 });
instagramPostSchema.index({ createdAt: -1 });

// Métodos
instagramPostSchema.methods.markPublished = async function(instagramPostId) {
  this.status = 'published';
  this.publishedAt = new Date();
  this.instagramPostId = instagramPostId;
  return await this.save();
};

instagramPostSchema.methods.markFailed = async function(error) {
  this.status = 'failed';
  this.errorMessage = error;
  return await this.save();
};

// Statics
instagramPostSchema.statics.findScheduledForPublish = function(limit = 1) {
  return this.find({
    status: 'scheduled',
    scheduledAt: { $lte: new Date() }
  })
  .sort({ scheduledAt: 1 })
  .limit(limit);
};

instagramPostSchema.statics.getStats = async function() {
  const total = await this.countDocuments();
  const byStatus = {
    draft: await this.countDocuments({ status: 'draft' }),
    scheduled: await this.countDocuments({ status: 'scheduled' }),
    published: await this.countDocuments({ status: 'published' }),
    failed: await this.countDocuments({ status: 'failed' })
  };
  
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const publishedThisMonth = await this.countDocuments({
    status: 'published',
    publishedAt: { $gte: startOfMonth }
  });

  return { total, byStatus, publishedThisMonth };
};

const InstagramPost = mongoose.model('InstagramPost', instagramPostSchema);

export default InstagramPost;
