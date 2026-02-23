/**
 * 📸 Model para Posts do Instagram
 */

import mongoose from 'mongoose';

const instagramPostSchema = new mongoose.Schema({
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
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'published', 'failed'],
    default: 'draft'
  },
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
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
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
