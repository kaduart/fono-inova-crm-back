/**
 * 🖼️ Vídeo Ilustrativo - Slideshow de imagens + narração
 * 
 * Busca imagens relacionadas ao tema e monta um vídeo
 * com transições suaves e narração OpenAI TTS
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';

// Usar ffmpeg do sistema
if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Palavras-chave por especialidade para buscar imagens
const KEYWORDS = {
  terapia_ocupacional: [
    'children occupational therapy sensory play',
    'kids therapy toys educational',
    'child development activities colorful'
  ],
  psicologia: [
    'child psychology therapy session caring',
    'children mental health support',
    'kids counseling safe space'
  ],
  fisioterapia: [
    'pediatric physiotherapy exercises',
    'children physical therapy fun',
    'kids rehabilitation playing'
  ],
  fonoaudiologia: [
    'speech therapy children',
    'kids language development games',
    'child speech exercises colorful'
  ],
  neuro: [
    'child neurological therapy',
    'kids cognitive development activities',
    'children brain therapy exercises'
  ],
  musicoterapia: [
    'music therapy children instruments',
    'kids playing music therapy',
    'children musical activities'
  ]
};

/**
 * Gera vídeo ilustrativo (slideshow)
 */
export async function gerarVideoIlustrativo({ 
  especialidadeId, 
  roteiro, 
  titulo,
  duracao = 30 
}) {
  const tmpDir = path.resolve(__dirname, '../../../tmp/videos');
  fs.mkdirSync(tmpDir, { recursive: true });

  const timestamp = Date.now();
  const baseName = `ilust_${timestamp}`;
  
  logger.info(`[VIDEO ILUST] Iniciando: ${especialidadeId} - "${titulo}"`);

  try {
    // 1. Buscar imagens
    const imagens = await buscarImagens({
      especialidade: especialidadeId,
      count: Math.ceil(duracao / 6), // 1 imagem a cada 6 segundos
      tmpDir,
      baseName
    });

    // 2. Gerar narração
    const audioPath = await gerarNarracao({
      texto: roteiro,
      outputPath: path.join(tmpDir, `${baseName}_audio.mp3`)
    });

    // 3. Montar slideshow
    const videoFinal = await montarSlideshow({
      imagens,
      audio: audioPath,
      duracao,
      outputPath: path.join(tmpDir, `${baseName}_final.mp4`)
    });

    // 4. Limpar temporários
    imagens.forEach(img => {
      try { fs.unlinkSync(img); } catch (e) {}
    });
    try { fs.unlinkSync(audioPath); } catch (e) {}

    logger.info(`[VIDEO ILUST] ✅ Finalizado: ${videoFinal}`);
    return videoFinal;

  } catch (error) {
    logger.error(`[VIDEO ILUST] ❌ Erro: ${error.message}`);
    throw error;
  }
}

/**
 * Busca imagens na Pexels ou usa placeholder
 */
async function buscarImagens({ especialidade, count, tmpDir, baseName }) {
  const imagens = [];
  
  // Tentar Pexels se tiver API key
  if (process.env.PEXELS_API_KEY && process.env.PEXELS_API_KEY !== 'sua_chave_aqui') {
    try {
      const keywords = KEYWORDS[especialidade] || KEYWORDS.terapia_ocupacional;
      const keyword = keywords[Math.floor(Math.random() * keywords.length)];
      
      const response = await axios.get('https://api.pexels.com/v1/search', {
        headers: { Authorization: process.env.PEXELS_API_KEY },
        params: {
          query: keyword,
          orientation: 'portrait',
          per_page: count + 5
        }
      });

      const photos = response.data.photos || [];
      
      for (let i = 0; i < Math.min(count, photos.length); i++) {
        const imgUrl = photos[i].src.portrait || photos[i].src.medium;
        const imgPath = path.join(tmpDir, `${baseName}_img_${i}.jpg`);
        
        const res = await axios.get(imgUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(imgPath, Buffer.from(res.data));
        imagens.push(imgPath);
      }
    } catch (e) {
      logger.warn(`[VIDEO ILUST] Erro Pexels: ${e.message}`);
    }
  }
  
  // Se não conseguiu imagens, criar placeholders coloridos
  if (imagens.length === 0) {
    logger.info(`[VIDEO ILUST] Criando placeholders coloridos`);
    for (let i = 0; i < count; i++) {
      const imgPath = path.join(tmpDir, `${baseName}_img_${i}.jpg`);
      await criarPlaceholder(imgPath, i);
      imagens.push(imgPath);
    }
  }
  
  return imagens;
}

/**
 * Cria imagem placeholder colorida com FFmpeg
 */
function criarPlaceholder(outputPath, index) {
  const cores = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD'];
  const cor = cores[index % cores.length];
  
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=${cor}:s=1080x1920:d=1`)
      .inputFormat('lavfi')
      .frames(1)
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

/**
 * Gera narração TTS em Português Brasileiro
 */
async function gerarNarracao({ texto, outputPath }) {
  logger.info(`[VIDEO ILUST] Gerando narração TTS (PT-BR)...`);
  
  // Usa voz 'onyx' (masculina) ou 'nova' (feminina) - melhores para PT-BR
  // OpenAI TTS suporta português brasileiro nativamente
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'nova', // voz feminina, boa para conteúdo pediátrico/terapêutico
    input: texto,
    speed: 0.95,
    response_format: 'mp3'
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  
  const stats = fs.statSync(outputPath);
  logger.info(`[VIDEO ILUST] ✅ Narração PT-BR gerada: ${(stats.size / 1024).toFixed(1)}KB`);
  
  return outputPath;
}

/**
 * Monta slideshow com FFmpeg - versão simplificada
 */
async function montarSlideshow({ imagens, audio, duracao, outputPath }) {
  logger.info(`[VIDEO ILUST] Montando slideshow com ${imagens.length} imagens...`);
  
  const duracaoPorImagem = duracao / imagens.length;
  const tmpDir = path.dirname(outputPath);
  
  // 1. Criar vídeo de cada imagem individualmente
  const videoSegments = [];
  for (let i = 0; i < imagens.length; i++) {
    const segmentPath = path.join(tmpDir, `segment_${i}.mp4`);
    await criarVideoDaImagem(imagens[i], segmentPath, duracaoPorImagem);
    videoSegments.push(segmentPath);
  }
  
  // 2. Criar arquivo de concatenação
  const listPath = outputPath.replace('.mp4', '_list.txt');
  const listContent = videoSegments.map(vid => `file '${vid}'`).join('\n');
  fs.writeFileSync(listPath, listContent);
  
  // 3. Concatenar vídeos e adicionar áudio
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .input(audio)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-shortest',
        '-pix_fmt yuv420p',
        '-movflags +faststart'
      ])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
  
  // 4. Limpar temporários
  try { fs.unlinkSync(listPath); } catch (e) {}
  videoSegments.forEach(vid => {
    try { fs.unlinkSync(vid); } catch (e) {}
  });
  
  return outputPath;
}

/**
 * Cria vídeo a partir de uma imagem estática
 */
function criarVideoDaImagem(imagemPath, outputPath, duracao) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagemPath)
      .inputOptions(['-loop 1'])
      .outputOptions([
        '-t', duracao,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-pix_fmt yuv420p'
      ])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

export default { gerarVideoIlustrativo };
