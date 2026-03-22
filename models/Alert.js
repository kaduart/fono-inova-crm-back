/**
 * 🚨 Modelo de Alertas Inteligentes - Landing Pages
 * Sistema de monitoramento com priorização
 */

import mongoose from 'mongoose';

const alertSchema = new mongoose.Schema({
  // Identificação
  title: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: true
  },
  
  // Prioridade: low | medium | high
  level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
    required: true
  },
  
  // Página afetada
  landingPage: {
    type: String,  // slug da LP
    required: true,
    index: true
  },
  landingPageTitle: {
    type: String
  },
  
  // Categoria do alerta
  category: {
    type: String,
    enum: ['conversion', 'traffic', 'seo', 'performance', 'engagement', 'technical'],
    required: true
  },
  
  // Métricas relacionadas
  metrics: {
    views: Number,
    leads: Number,
    conversionRate: Number,
    threshold: Number,  // valor que disparou o alerta
    currentValue: Number
  },
  
  // Status
  status: {
    type: String,
    enum: ['active', 'acknowledged', 'resolved', 'ignored'],
    default: 'active'
  },
  
  // Recomendação automática
  recommendation: {
    type: String,
    required: true
  },
  
  // Ações tomadas
  actions: [{
    type: {
      type: String,
      enum: ['acknowledge', 'resolve', 'ignore', 'note']
    },
    note: String,
    takenBy: String,
    takenAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Notificações enviadas
  notificationsSent: [{
    channel: {
      type: String,
      enum: ['email', 'whatsapp', 'dashboard', 'slack']
    },
    sentAt: {
      type: Date,
      default: Date.now
    },
    status: String
  }],
  
  // Expiração (alertas antigos são arquivados)
  expiresAt: {
    type: Date,
    default: function() {
      // Alertas críticos expiram em 30 dias, outros em 7
      const days = this.level === 'critical' ? 30 : 7;
      return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }
  }
}, {
  timestamps: true  // createdAt, updatedAt
});

// Índices para performance
alertSchema.index({ level: 1, status: 1, createdAt: -1 });
alertSchema.index({ landingPage: 1, createdAt: -1 });
alertSchema.index({ category: 1, level: 1 });
alertSchema.index({ status: 1, expiresAt: 1 });

// Métodos estáticos
alertSchema.statics.getActiveByPriority = async function() {
  return this.find({ 
    status: { $in: ['active', 'acknowledged'] }
  })
  .sort({ 
    level: -1,  // critical primeiro
    createdAt: -1 
  })
  .limit(50);
};

alertSchema.statics.getStats = async function() {
  return this.aggregate([
    { $match: { status: { $in: ['active', 'acknowledged'] } } },
    {
      $group: {
        _id: '$level',
        count: { $sum: 1 },
        pages: { $addToSet: '$landingPage' }
      }
    }
  ]);
};

// Método para marcar como resolvido
alertSchema.methods.resolve = async function(userId, note = '') {
  this.status = 'resolved';
  this.actions.push({
    type: 'resolve',
    note,
    takenBy: userId,
    takenAt: new Date()
  });
  return this.save();
};

// Método para reconhecer
alertSchema.methods.acknowledge = async function(userId, note = '') {
  this.status = 'acknowledged';
  this.actions.push({
    type: 'acknowledge',
    note,
    takenBy: userId,
    takenAt: new Date()
  });
  return this.save();
};

const Alert = mongoose.model('Alert', alertSchema);

export default Alert;
