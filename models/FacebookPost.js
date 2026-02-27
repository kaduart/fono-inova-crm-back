/**
 * 📘 Model para Posts do Facebook
 */

import mongoose from 'mongoose';

const facebookPostSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
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
    enum: ['image', 'video', 'link'],
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
  facebookPostId: {
    type: String,
    default: null
  },
  engagement: {
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    shares: { type: Number, default: 0 }
  },
  aiGenerated: {
    type: Boolean,
    default: false
  },
  aiModel: {
    type: String,
    default: null
  },
  // 🖼️ Qual IA gerou a imagem
  imageProvider: {
    type: String,
    default: null
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// Índices
facebookPostSchema.index({ status: 1, scheduledAt: 1 });
facebookPostSchema.index({ theme: 1 });
facebookPostSchema.index({ createdAt: -1 });

// Métodos
facebookPostSchema.methods.markPublished = async function(facebookPostId) {
  this.status = 'published';
  this.publishedAt = new Date();
  this.facebookPostId = facebookPostId;
  return await this.save();
};

facebookPostSchema.methods.markFailed = async function(error) {
  this.status = 'failed';
  this.errorMessage = error;
  return await this.save();
};

// Statics
facebookPostSchema.statics.findScheduledForPublish = function(limit = 1) {
  return this.find({
    status: 'scheduled',
    scheduledAt: { $lte: new Date() }
  })
  .sort({ scheduledAt: 1 })
  .limit(limit);
};

facebookPostSchema.statics.getStats = async function() {
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

const FacebookPost = mongoose.model('FacebookPost', facebookPostSchema);

export default FacebookPost;
