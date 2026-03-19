/**
 * 🖼️ ImageBank - Banco de Imagens Reutilizáveis
 * Armazena imagens organizadas por especialidade e tema
 */

import mongoose from 'mongoose';

const ImageBankSchema = new mongoose.Schema({
  // URL da imagem no Cloudinary
  url: {
    type: String,
    required: true,
    index: true
  },
  
  // Public ID no Cloudinary (para delete/update)
  publicId: {
    type: String,
    required: true,
    unique: true
  },
  
  // Especialidade (fonoaudiologia, psicologia, etc)
  especialidade: {
    type: String,
    required: true,
    index: true,
    enum: [
      'fonoaudiologia',
      'psicologia', 
      'terapia_ocupacional',
      'fisioterapia',
      'psicomotricidade',
      'neuropsicologia',
      'musicoterapia',
      'psicopedagogia',
      'psicopedagogia_clinica',
      'freio_lingual',
      'autismo',
      'general'
    ]
  },
  
  // Tema específico (troca de letras, ansiedade, etc)
  tema: {
    type: String,
    required: true,
    index: true
  },
  
  // Tags para busca
  tags: [{
    type: String,
    index: true
  }],
  
  // Dimensões
  width: Number,
  height: Number,
  
  // Tamanho em bytes
  size: Number,
  
  // Formato
  format: {
    type: String,
    default: 'jpg'
  },
  
  // Provider original (fal.ai, dalle, etc)
  provider: {
    type: String,
    default: 'unknown'
  },
  
  // Prompt usado para gerar (se aplicável)
  prompt: String,
  
  // Número de vezes que foi usada
  usageCount: {
    type: Number,
    default: 0
  },
  
  // Último uso
  lastUsed: Date,
  
  // Status
  status: {
    type: String,
    enum: ['active', 'archived', 'deleted'],
    default: 'active',
    index: true
  },
  
  // Se é uma imagem de fallback/genérica
  isGeneric: {
    type: Boolean,
    default: false
  },
  
  // Metadata adicional
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Índices compostos para busca eficiente
ImageBankSchema.index({ especialidade: 1, tema: 1, status: 1 });
ImageBankSchema.index({ especialidade: 1, isGeneric: 1, status: 1 });
ImageBankSchema.index({ tags: 1, status: 1 });

// Método para marcar uso
ImageBankSchema.methods.markUsage = async function() {
  this.usageCount += 1;
  this.lastUsed = new Date();
  await this.save();
};

// Static method para buscar imagem por especialidade/tema
ImageBankSchema.statics.findByEspecialidadeETema = async function(especialidade, tema, options = {}) {
  const { preferGeneric = false, limit = 10 } = options;
  
  // Primeiro tenta buscar por tema específico
  let query = {
    especialidade,
    status: 'active'
  };
  
  if (tema) {
    query.$or = [
      { tema: { $regex: tema, $options: 'i' } },
      { tags: { $in: [new RegExp(tema, 'i')] } }
    ];
  }
  
  let images = await this.find(query)
    .sort({ usageCount: 1, lastUsed: 1 }) // Menos usadas primeiro
    .limit(limit);
  
  // Se não encontrou específica, busca genérica da especialidade
  if (images.length === 0 && !preferGeneric) {
    images = await this.find({
      especialidade,
      isGeneric: true,
      status: 'active'
    })
    .sort({ usageCount: 1, lastUsed: 1 })
    .limit(limit);
  }
  
  // Se ainda não encontrou, busca qualquer imagem ativa
  if (images.length === 0) {
    images = await this.find({ status: 'active' })
      .sort({ usageCount: 1, lastUsed: 1 })
      .limit(limit);
  }
  
  return images;
};

// Static method para buscar uma imagem aleatória
ImageBankSchema.statics.getRandomImage = async function(especialidade, tema) {
  const images = await this.findByEspecialidadeETema(especialidade, tema, { limit: 5 });
  
  if (images.length === 0) return null;
  
  // Seleciona aleatoriamente entre as menos usadas
  const randomIndex = Math.floor(Math.random() * Math.min(images.length, 3));
  const selected = images[randomIndex];
  
  // Marca uso
  await selected.markUsage();
  
  return selected;
};

// Static method para adicionar nova imagem
ImageBankSchema.statics.addImage = async function(data) {
  const image = new this(data);
  await image.save();
  return image;
};

// Static method para popular banco com imagens existentes
ImageBankSchema.statics.populateFromCloudinary = async function(cloudinaryResources, especialidade) {
  const results = [];
  
  for (const resource of cloudinaryResources) {
    try {
      // Verifica se já existe
      const exists = await this.findOne({ publicId: resource.public_id });
      if (exists) continue;
      
      // Determina tema baseado no nome do arquivo ou pasta
      const folderParts = resource.public_id.split('/');
      const tema = folderParts[folderParts.length - 2] || 'general';
      
      const image = await this.addImage({
        url: resource.secure_url,
        publicId: resource.public_id,
        especialidade: especialidade || 'general',
        tema: tema,
        tags: [tema, especialidade].filter(Boolean),
        width: resource.width,
        height: resource.height,
        size: resource.bytes,
        format: resource.format,
        isGeneric: folderParts.includes('generic') || folderParts.includes('fallback')
      });
      
      results.push(image);
    } catch (e) {
      console.error('Erro ao adicionar imagem:', e.message);
    }
  }
  
  return results;
};

export default mongoose.model('ImageBank', ImageBankSchema);
