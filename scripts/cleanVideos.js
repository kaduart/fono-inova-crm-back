/**
 * 🧹 Script para limpar vídeos antigos com URLs quebradas
 */

import mongoose from 'mongoose';
import Video from '../models/Video.js';

async function cleanVideos() {
  try {
    // Conecta ao MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
    console.log('✅ Conectado ao MongoDB');

    // Deleta vídeos com URL example.com (mock antigo)
    const result = await Video.deleteMany({
      $or: [
        { videoUrl: { $regex: 'example.com' } },
        { thumbnailUrl: { $regex: 'example.com' } }
      ]
    });

    console.log(`🗑️ ${result.deletedCount} vídeos antigos deletados`);

    // Lista vídeos restantes
    const remaining = await Video.countDocuments();
    console.log(`📊 ${remaining} vídeos restantes no banco`);

    await mongoose.disconnect();
    console.log('✅ Concluído');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

cleanVideos();
