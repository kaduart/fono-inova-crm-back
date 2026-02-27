/**
 * 📊 Layout History Model
 * Persistência do histórico de layouts usados (round-robin)
 * Evita repetição nos últimos 3 posts
 */

import mongoose from 'mongoose';

const layoutHistorySchema = new mongoose.Schema({
  // Canal (instagram, gmb, etc)
  channel: {
    type: String,
    default: 'instagram',
    index: true
  },
  
  // Especialidade (fonoaudiologia, psicologia, etc)
  especialidadeId: {
    type: String,
    required: true,
    index: true
  },
  
  // Categoria do layout usado
  categoria: {
    type: String,
    required: true
  },
  
  // ID do layout utilizado
  layoutId: {
    type: String,
    required: true
  },
  
  // Referência ao post gerado
  postId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InstagramPost',
    default: null
  },
  
  // Timestamp
  usedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Índice composto para queries eficientes
layoutHistorySchema.index({ channel: 1, especialidadeId: 1, usedAt: -1 });

/**
 * Obtém os últimos N layouts usados para uma especialidade
 */
layoutHistorySchema.statics.getRecentLayouts = async function(
  especialidadeId, 
  channel = 'instagram', 
  limit = 3
) {
  const history = await this.find({
    channel,
    especialidadeId
  })
    .sort({ usedAt: -1 })
    .limit(limit)
    .select('layoutId usedAt')
    .lean();
  
  return history.map(h => h.layoutId);
};

/**
 * Registra uso de um layout
 */
layoutHistorySchema.statics.registerUsage = async function(
  layoutId, 
  especialidadeId, 
  categoria, 
  postId = null,
  channel = 'instagram'
) {
  return await this.create({
    channel,
    especialidadeId,
    categoria,
    layoutId,
    postId,
    usedAt: new Date()
  });
};

/**
 * Limpa histórico antigo (manter só últimos 50 por especialidade)
 */
layoutHistorySchema.statics.cleanupOld = async function(
  especialidadeId, 
  channel = 'instagram',
  keepLast = 50
) {
  const recent = await this.find({
    channel,
    especialidadeId
  })
    .sort({ usedAt: -1 })
    .skip(keepLast)
    .select('_id')
    .lean();
  
  if (recent.length > 0) {
    const idsToDelete = recent.map(r => r._id);
    await this.deleteMany({ _id: { $in: idsToDelete } });
    return idsToDelete.length;
  }
  
  return 0;
};

/**
 * Estatísticas de uso por layout
 */
layoutHistorySchema.statics.getStats = async function(
  especialidadeId = null,
  channel = 'instagram'
) {
  const match = { channel };
  if (especialidadeId) match.especialidadeId = especialidadeId;
  
  const stats = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$layoutId',
        count: { $sum: 1 },
        lastUsed: { $max: '$usedAt' }
      }
    },
    { $sort: { count: -1 } }
  ]);
  
  return stats;
};

const LayoutHistory = mongoose.model('LayoutHistory', layoutHistorySchema);

export default LayoutHistory;
