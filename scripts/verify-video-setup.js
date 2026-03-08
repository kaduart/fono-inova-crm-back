#!/usr/bin/env node
/**
 * 🎬 Verificação de setup para edição de vídeo
 * Executar: node scripts/verify-video-setup.js
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🎬 VERIFICAÇÃO DE SETUP - Edição de Vídeo\n');
console.log('=' .repeat(50));

let errors = 0;

// 1. Verificar FFmpeg
console.log('\n📹 1. Verificando FFmpeg...');
try {
  const ffmpegVersion = execSync('ffmpeg -version', { encoding: 'utf8' }).split('\n')[0];
  console.log('   ✅ FFmpeg instalado:', ffmpegVersion);
  
  // Verificar se tem suporte a ass
  const filters = execSync('ffmpeg -filters', { encoding: 'utf8' });
  if (filters.includes('ass')) {
    console.log('   ✅ Filtro ASS disponível');
  } else {
    console.log('   ❌ Filtro ASS NÃO disponível');
    errors++;
  }
  
  if (filters.includes('drawtext')) {
    console.log('   ✅ Filtro drawtext disponível');
  } else {
    console.log('   ❌ Filtro drawtext NÃO disponível');
    errors++;
  }
} catch (err) {
  console.log('   ❌ FFmpeg NÃO instalado');
  errors++;
}

// 2. Verificar fontes
console.log('\n🔤 2. Verificando fontes...');
try {
  const fonts = execSync('fc-list : family', { encoding: 'utf8' });
  
  if (fonts.includes('Roboto')) {
    console.log('   ✅ Fonte Roboto instalada');
  } else {
    console.log('   ⚠️  Fonte Roboto NÃO encontrada (usando fallback)');
  }
  
  if (fonts.includes('DejaVu')) {
    console.log('   ✅ Fonte DejaVu instalada (fallback)');
  }
  
  if (fonts.includes('Arial')) {
    console.log('   ✅ Fonte Arial instalada');
  }
} catch (err) {
  console.log('   ⚠️  Não foi possível verificar fontes');
}

// 3. Verificar músicas
console.log('\n🎵 3. Verificando arquivos de música...');
const musicDir = path.join(__dirname, '../assets/music');
const requiredSongs = ['musica_calma.mp3', 'musica_esperancosa.mp3', 'musica_emocional.mp3'];

for (const song of requiredSongs) {
  const songPath = path.join(musicDir, song);
  if (fs.existsSync(songPath)) {
    const stats = fs.statSync(songPath);
    console.log(`   ✅ ${song} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  } else {
    console.log(`   ❌ ${song} NÃO encontrado`);
    errors++;
  }
}

// 4. Verificar diretório temp
console.log('\n📁 4. Verificando diretórios temporários...');
const tmpDirs = ['/tmp', '/tmp/pos_producao'];
for (const dir of tmpDirs) {
  if (fs.existsSync(dir)) {
    console.log(`   ✅ ${dir} existe`);
  } else {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`   ✅ ${dir} criado`);
    } catch (err) {
      console.log(`   ❌ Não foi possível criar ${dir}`);
      errors++;
    }
  }
}

// 5. Verificar variáveis de ambiente
console.log('\n🔑 5. Verificando variáveis de ambiente...');
const requiredEnv = ['OPENAI_API_KEY', 'CLOUDINARY_CLOUD_NAME'];
for (const env of requiredEnv) {
  if (process.env[env]) {
    console.log(`   ✅ ${env} configurada`);
  } else {
    console.log(`   ⚠️  ${env} NÃO configurada (legendas podem falhar)`);
  }
}

// Resumo
console.log('\n' + '='.repeat(50));
if (errors === 0) {
  console.log('✅ TUDO CERTO! Sistema pronto para edição de vídeo.');
} else {
  console.log(`❌ Encontrados ${errors} problema(s). Corrija antes de prosseguir.`);
  process.exit(1);
}
