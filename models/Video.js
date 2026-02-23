/**
 * 🎬 Model para Vídeos HeyGen
 */

import mongoose from 'mongoose';

const videoSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  roteiro: {
    type: String,
    required: true
  },
  especialidadeId: {
    type: String,
    required: true
  },
  avatarId: {
    type: String,
    default: null
  },
  duration: {
    type: Number,
    default: 30,
    enum: [30, 45, 60]
  },
  status: {
    type: String,
    enum: ['processing', 'ready', 'failed'],
    default: 'processing'
  },
  videoUrl: {
    type: String,
    default: null
  },
  thumbnailUrl: {
    type: String,
    default: null
  },
  heygenVideoId: {
    type: String,
    default: null
  },
  provider: {
    type: String,
    enum: ['heygen'],
    default: 'heygen'
  },
  publishedChannels: [{
    type: String,
    enum: ['instagram', 'facebook', 'gmb']
  }],
  publishedAt: {
    type: Date,
    default: null
  },
  errorMessage: {
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
videoSchema.index({ status: 1 });
videoSchema.index({ especialidadeId: 1 });
videoSchema.index({ createdAt: -1 });

// Métodos
videoSchema.methods.markReady = async function(videoUrl, thumbnailUrl) {
  this.status = 'ready';
  this.videoUrl = videoUrl;
  this.thumbnailUrl = thumbnailUrl;
  return await this.save();
};

videoSchema.methods.markFailed = async function(error) {
  this.status = 'failed';
  this.errorMessage = error;
  return await this.save();
};

const Video = mongoose.model('Video', videoSchema);

export default Video;
