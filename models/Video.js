/**
 * 🎬 Model para Vídeos — Pipeline Automático (HeyGen + FFmpeg)
 */

import mongoose from 'mongoose';

const videoSchema = new mongoose.Schema({
  // ✅ CAMPOS EXISTENTES (mantidos para compatibilidade)
  title: {
    type: String,
    required: true
  },
  roteiro: {
    type: String,
    default: ''
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
    default: 60,
    enum: [30, 45, 60, 90, 120, 180, 300]
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
    enum: ['heygen', 'veo-3.1', 'slideshow', 'runway'],
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
  },

  // 🆕 NOVOS CAMPOS — Pipeline Automático
  
  // Job tracking
  jobId: {
    type: String,
    unique: true,
    sparse: true
  },
  
  // Status detalhado do pipeline
  pipelineStatus: {
    type: String,
    enum: ['ROTEIRO', 'HEYGEN', 'VEO', 'POS_PRODUCAO', 'UPLOAD', 'CONCLUIDO', 'ERRO'],
    default: 'ROTEIRO'
  },
  
  // Roteiro estruturado (ZEUS)
  roteiroEstruturado: {
    titulo: String,
    profissional: String,
    duracaoEstimada: Number,
    textoCompleto: String,
    hookTextoOverlay: String,
    ctaTextoOverlay: String,
    hashtags: [String],
    copyAnuncio: {
      textoPrimario: String,
      headline: String,
      descricao: String
    }
  },
  
  // URLs dos vídeos (raw vs final)
  videoCruUrl: {      // HeyGen raw
    type: String,
    default: null
  },
  videoFinalUrl: {    // Após FFmpeg
    type: String,
    default: null
  },
  legendaSrtUrl: {    // Arquivo SRT gerado
    type: String,
    default: null
  },
  
  // 🆕 Pós-produção manual (editor frontend)
  videoEditadoUrl: {
    type: String,
    default: null
  },
  posProducaoStatus: {
    type: String,
    enum: ['idle', 'processing', 'ready', 'failed'],
    default: 'idle'
  },
  posProducaoConfig: {
    legendas:   { type: Boolean, default: true },
    musica:     { type: String, default: null },
    cta: {
      texto:    { type: String, default: null },
      subtexto: { type: String, default: null },
      cor:      { type: String, default: '#ef4444' }
    },
    aplicadoEm: { type: Date, default: null }
  },
  posProducaoError: {
    type: String,
    default: null
  },

  // 🔁 Clips parciais — permite retomar geração de onde parou
  clipsGerados: {
    type: [String],
    default: []
  },
  numClipsTotal: {
    type: Number,
    default: null
  },

  // Meta Ads (futuro)
  metaCampaignId: {
    type: String,
    default: null
  },
  metaCreativeId: {
    type: String,
    default: null
  },
  metaAdsetId: {
    type: String,
    default: null
  },
  metaAdId: {
    type: String,
    default: null
  },
  
  // Timestamps do pipeline
  tempos: {
    roteiroEm: Date,
    heygenEm: Date,
    posProducaoEm: Date,
    uploadEm: Date,
    concluidoEm: Date
  },
  
  // Progresso (para Socket.IO)
  progresso: {
    etapa: {
      type: String,
      default: 'ROTEIRO'
    },
    percentual: {
      type: Number,
      default: 0
    },
    atualizadoEm: {
      type: Date,
      default: Date.now
    }
  },
  
  // Configurações usadas
  config: {
    funil: {
      type: String,
      enum: ['TOPO', 'MEIO', 'FUNDO'],
      default: 'TOPO'
    },
    musica: {
      type: String,
      enum: ['calma', 'esperancosa', 'emocional'],
      default: 'calma'
    },
    publicarMeta: {
      type: Boolean,
      default: false
    }
  },

  // 🧠 Inteligência de conteúdo (Growth Engine)
  contentType: {
    type: String,
    enum: ['instagram', 'ads', 'educativo', 'viral'],
    default: 'instagram'
  },
  platform: {
    type: String,
    enum: ['instagram', 'meta_ads'],
    default: 'instagram'
  },
  subTema: {
    type: String,
    enum: [
      'atraso_fala', 'autismo', 'comportamento', 'teste_linguinha',
      'avaliacao_neuropsicologica', 'coordenacao_motora',
      'terapia_ocupacional', 'fisioterapia_infantil', 'psicomotricidade'
    ],
    default: null
  },
  hookStyle: {
    type: String,
    enum: ['dor', 'alerta', 'curiosidade', 'erro_comum', 'autoridade'],
    default: 'dor'
  },
  objetivo: {
    type: String,
    enum: ['salvar', 'compartilhar', 'comentar', 'agendar'],
    default: 'salvar'
  },
  intensidade: {
    type: String,
    enum: ['leve', 'moderado', 'forte', 'viral'],
    default: 'viral'
  },
  estruturaUsada: {
    type: String,
    default: null
  },
  hookTextoGerado: {
    type: String,
    default: null
  },
  legendaInstagram: {
    type: String,
    default: null
  }

}, {
  timestamps: true
});

// Índices otimizados
videoSchema.index({ status: 1 });
videoSchema.index({ especialidadeId: 1 });
videoSchema.index({ createdAt: -1 });
videoSchema.index({ jobId: 1 });
videoSchema.index({ pipelineStatus: 1 });
videoSchema.index({ 'config.funil': 1 });
videoSchema.index({ platform: 1 });
videoSchema.index({ subTema: 1 });
videoSchema.index({ hookStyle: 1 });

// Métodos úteis

/**
 * Marca vídeo como pronto
 */
videoSchema.methods.markReady = async function(videoFinalUrl, thumbnailUrl) {
  this.status = 'ready';
  this.videoUrl = videoFinalUrl;
  this.videoFinalUrl = videoFinalUrl;
  this.thumbnailUrl = thumbnailUrl;
  this.pipelineStatus = 'CONCLUIDO';
  this.tempos.concluidoEm = new Date();
  this.progresso = { etapa: 'CONCLUIDO', percentual: 100, atualizadoEm: new Date() };
  return await this.save();
};

/**
 * Marca vídeo como falho
 */
videoSchema.methods.markFailed = async function(error) {
  this.status = 'failed';
  this.errorMessage = error?.message || error;
  this.pipelineStatus = 'ERRO';
  this.progresso = { etapa: 'ERRO', percentual: 0, atualizadoEm: new Date() };
  return await this.save();
};

/**
 * Atualiza progresso do pipeline
 */
videoSchema.methods.updateProgress = async function(etapa, percentual) {
  this.pipelineStatus = etapa;
  this.progresso = { etapa, percentual, atualizadoEm: new Date() };
  
  // Atualiza timestamp da etapa
  if (this.tempos) {
    const campoEtapa = etapa.toLowerCase().replace('_', '') + 'Em';
    if (this.tempos[campoEtapa] !== undefined) {
      this.tempos[campoEtapa] = new Date();
    }
  }
  
  return await this.save();
};

/**
 * Busca vídeos por status do pipeline
 */
videoSchema.statics.findByPipelineStatus = function(status) {
  return this.find({ pipelineStatus: status }).sort({ createdAt: -1 });
};

/**
 * Estatísticas do pipeline
 */
videoSchema.statics.getPipelineStats = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: '$pipelineStatus',
        count: { $sum: 1 }
      }
    }
  ]);
  
  const total = await this.countDocuments();
  
  return {
    total,
    byStatus: stats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {})
  };
};

const Video = mongoose.model('Video', videoSchema);

export default Video;
