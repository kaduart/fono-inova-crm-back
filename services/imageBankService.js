/**
 * 🖼️ ImageBank Service
 * Gerencia reúso de imagens do banco
 */

import ImageBank from '../models/ImageBank.js';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * 🔍 Busca imagem no banco por especialidade e tema
 */
export async function findExistingImage(especialidade, tema = '', options = {}) {
  console.log(`🔍 [ImageBank] Buscando: ${especialidade}/${tema}`);
  
  const image = await ImageBank.getRandomImage(especialidade, tema);
  
  if (image) {
    console.log(`✅ [ImageBank] Imagem encontrada: ${image.url.substring(0, 60)}...`);
    console.log(`   → Usada ${image.usageCount} vezes`);
    console.log(`   → Último uso: ${image.lastUsed ? new Date(image.lastUsed).toLocaleDateString() : 'nunca'}`);
    return {
      url: image.url,
      publicId: image.publicId,
      provider: 'imagebank',
      reuseCount: image.usageCount,
      isReused: true
    };
  }
  
  console.log(`⚠️ [ImageBank] Nenhuma imagem encontrada para ${especialidade}/${tema}`);
  return null;
}

/**
 * 💾 Salva nova imagem no banco
 */
export async function saveImageToBank(data) {
  try {
    const {
      url,
      publicId,
      especialidade,
      tema,
      provider,
      prompt,
      tags = []
    } = data;
    
    // Verifica se já existe
    const exists = await ImageBank.findOne({ publicId });
    if (exists) {
      console.log(`⚠️ [ImageBank] Imagem já existe: ${publicId}`);
      return exists;
    }
    
    // Busca info do Cloudinary
    let cloudinaryInfo = {};
    try {
      const result = await cloudinary.api.resource(publicId);
      cloudinaryInfo = {
        width: result.width,
        height: result.height,
        size: result.bytes,
        format: result.format
      };
    } catch (e) {
      console.warn('⚠️ Não foi possível buscar info do Cloudinary:', e.message);
    }
    
    const image = await ImageBank.addImage({
      url,
      publicId,
      especialidade: especialidade || 'general',
      tema: tema || 'general',
      tags: [...tags, especialidade, tema].filter(Boolean),
      provider: provider || 'unknown',
      prompt,
      isGeneric: false,
      ...cloudinaryInfo
    });
    
    console.log(`✅ [ImageBank] Nova imagem salva: ${publicId}`);
    return image;
  } catch (e) {
    console.error('❌ [ImageBank] Erro ao salvar:', e.message);
    return null;
  }
}

/**
 * 📊 Estatísticas do banco
 */
export async function getBankStats() {
  const stats = await ImageBank.aggregate([
    { $match: { status: 'active' } },
    {
      $group: {
        _id: '$especialidade',
        count: { $sum: 1 },
        totalUsage: { $sum: '$usageCount' },
        avgUsage: { $avg: '$usageCount' }
      }
    },
    { $sort: { count: -1 } }
  ]);
  
  const total = await ImageBank.countDocuments({ status: 'active' });
  
  return {
    total,
    byEspecialidade: stats,
    mostUsed: await ImageBank.find({ status: 'active' })
      .sort({ usageCount: -1 })
      .limit(5)
      .select('especialidade tema usageCount url')
  };
}

/**
 * 🗑️ Arquivar imagem
 */
export async function archiveImage(publicId) {
  const image = await ImageBank.findOneAndUpdate(
    { publicId },
    { status: 'archived' },
    { new: true }
  );
  return image;
}

/**
 * 🔧 Migrar imagens existentes do Cloudinary
 */
export async function migrateExistingImages(especialidade, folder = null) {
  console.log(`🔄 [ImageBank] Migrando imagens de ${folder || 'todas as pastas'}...`);
  
  const folders = folder ? [folder] : [
    'fono-inova/gmb',
    'fono-inova/instagram',
    'fono-inova/lovart',
    'fono-inova/json-layouts'
  ];
  
  let totalMigrated = 0;
  
  for (const f of folders) {
    try {
      console.log(`   📁 Verificando: ${f}`);
      const result = await cloudinary.api.resources({
        type: 'upload',
        prefix: f,
        max_results: 500
      });
      
      const migrated = await ImageBank.populateFromCloudinary(
        result.resources,
        especialidade
      );
      
      totalMigrated += migrated.length;
      console.log(`   ✅ ${migrated.length} imagens migradas de ${f}`);
    } catch (e) {
      console.error(`   ❌ Erro em ${f}:`, e.message);
    }
  }
  
  console.log(`✅ [ImageBank] Total migrado: ${totalMigrated}`);
  return totalMigrated;
}

/**
 * 🎯 Wrapper inteligente: busca no banco ou gera nova
 */
export async function getOrCreateImage({
  especialidade,
  tema,
  generateFn,
  preferReuse = true,
  saveNew = true
}) {
  // Primeiro tenta reutilizar
  if (preferReuse) {
    const existing = await findExistingImage(especialidade, tema);
    if (existing) {
      return existing;
    }
  }
  
  // Se não achou, gera nova
  if (!generateFn) {
    throw new Error('Nenhuma imagem encontrada e generateFn não fornecida');
  }
  
  console.log(`🎨 [ImageBank] Gerando nova imagem...`);
  const newImage = await generateFn();
  
  // Salva no banco se solicitado
  if (saveNew && newImage?.url && newImage?.publicId) {
    await saveImageToBank({
      url: newImage.url,
      publicId: newImage.publicId,
      especialidade,
      tema,
      provider: newImage.provider,
      prompt: newImage.prompt
    });
  }
  
  return { ...newImage, isReused: false };
}

export default {
  findExistingImage,
  saveImageToBank,
  getBankStats,
  archiveImage,
  migrateExistingImages,
  getOrCreateImage
};
