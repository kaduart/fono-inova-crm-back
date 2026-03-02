/**
 * 🎬 Vídeos Profissionais para Clínica Pediátrica
 * 
 * Solução profissional: Vídeos de stock reais + narração TTS
 * - Cenários de salas terapêuticas
 * - Brinquedos educativos
 * - Crianças em atividades terapêuticas
 * - Narração profissional OpenAI TTS
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// APIs de vídeo stock (gratuitas)
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// Cenários terapêuticos por especialidade
const CENARIOS = {
  terapia_ocupacional: {
    buscas: [
      'occupational therapy children playing',
      'sensory play therapy kids toys',
      'pediatric therapy room colorful',
      'child development activities toys'
    ],
    cores: ['#FF6B6B', '#4ECDC4', '#45B7D1'],
    musica: 'calma'
  },
  psicologia: {
    buscas: [
      'child psychology therapy session',
      'kids mental health counseling',
      'children therapy room safe space',
      'pediatric psychologist playing'
    ],
    cores: ['#9B59B6', '#3498DB', '#E74C3C'],
    musica: 'esperancosa'
  },
  fisioterapia: {
    buscas: [
      'pediatric physiotherapy exercises',
      'child physical therapy fun',
      'kids rehabilitation play',
      'baby physiotherapy colorful'
    ],
    cores: ['#2ECC71', '#F39C12', '#1ABC9C'],
    musica: 'emocional'
  },
  fonoaudiologia: {
    buscas: [
      'speech therapy children',
      'kids speech development games',
      'pediatric speech therapist',
      'child language therapy'
    ],
    cores: ['#E91E63', '#9C27B0', '#673AB7'],
    musica: 'calma'
  },
  neuro: {
    buscas: [
      'child neurological therapy',
      'kids brain development activities',
      'pediatric neurorehabilitation',
      'children cognitive therapy'
    ],
    cores: ['#00BCD4', '#009688', '#8BC34A'],
    musica: 'esperancosa'
  },
  musicoterapia: {
    buscas: [
      'music therapy children',
      'kids music therapy instruments',
      'children playing musical instruments',
      'pediatric music therapy session'
    ],
    cores: ['#FF9800', '#FF5722', '#795548'],
    musica: 'emocional'
  }
};

/**
 * Gera vídeo profissional completo
 */
export async function gerarVideoProfissional({ 
  especialidadeId, 
  roteiro, 
  titulo,
  duracao = 30 
}) {
  const tmpDir = path.resolve(__dirname, '../../../tmp/videos');
  fs.mkdirSync(tmpDir, { recursive: true });

  const timestamp = Date.now();
  const baseName = `video_${timestamp}`;
  
  logger.info(`[VIDEO PRO] Iniciando vídeo profissional: ${especialidadeId} - "${titulo}"`);

  try {
    // 1. Buscar vídeo de stock
    const videoStockPath = await buscarVideoStock({
      especialidade: especialidadeId,
      duracao,
      outputPath: path.join(tmpDir, `${baseName}_stock.mp4`)
    });

    // 2. Gerar narração de áudio
    const audioPath = await gerarNarracao({
      texto: roteiro,
      outputPath: path.join(tmpDir, `${baseName}_audio.mp3`)
    });

    // 3. Montar vídeo final
    const videoFinal = await montarVideoFinal({
      videoStock: videoStockPath,
      audio: audioPath,
      titulo,
      especialidade: especialidadeId,
      outputPath: path.join(tmpDir, `${baseName}_final.mp4`)
    });

    // 4. Limpar temporários
    try {
      fs.unlinkSync(videoStockPath);
      fs.unlinkSync(audioPath);
    } catch (e) {
      // ignore
    }

    logger.info(`[VIDEO PRO] ✅ Vídeo finalizado: ${videoFinal}`);
    return videoFinal;

  } catch (error) {
    logger.error(`[VIDEO PRO] ❌ Erro: ${error.message}`);
    throw error;
  }
}

/**
 * Busca vídeo de stock na Pexels
 */
async function buscarVideoStock({ especialidade, duracao, outputPath }) {
  if (!PEXELS_API_KEY || PEXELS_API_KEY === 'sua_chave_aqui') {
    throw new Error('PEXELS_API_KEY não configurada - usando fallback HeyGen');
  }

  const cenario = CENARIOS[especialidade] || CENARIOS.terapia_ocupacional;
  const busca = cenario.buscas[Math.floor(Math.random() * cenario.buscas.length)];

  logger.info(`[VIDEO PRO] Buscando vídeo: "${busca}"`);

  // Buscar na Pexels
  const response = await axios.get('https://api.pexels.com/videos/search', {
    headers: { Authorization: PEXELS_API_KEY },
    params: {
      query: busca,
      orientation: 'portrait',
      size: 'medium',
      per_page: 10
    }
  });

  const videos = response.data.videos;
  if (!videos || videos.length === 0) {
    throw new Error('Nenhum vídeo encontrado na Pexels');
  }

  // Escolher vídeo aleatório
  const video = videos[Math.floor(Math.random() * videos.length)];
  const videoFile = video.video_files.find(v => v.quality === 'hd' || v.quality === 'sd') || video.video_files[0];

  logger.info(`[VIDEO PRO] Download: ${videoFile.link.substring(0, 60)}...`);

  // Download
  const res = await axios.get(videoFile.link, { responseType: 'stream' });
  
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  // Verificar duração e cortar se necessário
  const videoDuracao = await getDuracao(outputPath);
  
  if (videoDuracao > duracao + 2) {
    // Cortar para a duração desejada
    const cutPath = outputPath.replace('_stock.mp4', '_stock_cut.mp4');
    await cortarVideo(outputPath, cutPath, duracao);
    fs.renameSync(cutPath, outputPath);
  }

  logger.info(`[VIDEO PRO] ✅ Vídeo stock baixado: ${videoDuracao.toFixed(1)}s`);
  return outputPath;
}

/**
 * Gera narração com OpenAI TTS
 */
async function gerarNarracao({ texto, outputPath }) {
  logger.info(`[VIDEO PRO] Gerando narração TTS...`);

  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'alloy', // alloy, echo, fable, onyx, nova, shimmer
    input: texto,
    speed: 0.95
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  const stats = fs.statSync(outputPath);
  logger.info(`[VIDEO PRO] ✅ Narração gerada: ${(stats.size / 1024).toFixed(1)}KB`);

  return outputPath;
}

/**
 * Monta vídeo final com FFmpeg
 */
async function montarVideoFinal({ videoStock, audio, titulo, especialidade, outputPath }) {
  const cenario = CENARIOS[especialidade] || CENARIOS.terapia_ocupacional;
  const cor = cenario.cores[0];

  const duracaoVideo = await getDuracao(videoStock);
  const duracaoAudio = await getDuracao(audio);
  const duracaoFinal = Math.min(duracaoVideo, duracaoAudio);

  logger.info(`[VIDEO PRO] Montando vídeo: vídeo=${duracaoVideo.toFixed(1)}s, áudio=${duracaoAudio.toFixed(1)}s`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoStock)
      .input(audio)
      .complexFilter([
        // Ajustar vídeo para 9:16 se necessário
        '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[v]',
        // Áudio fade in/out
        `[1:a]afade=t=in:st=0:d=1,afade=t=out:st=${duracaoFinal-1}:d=1[a]`
      ])
      .outputOptions([
        '-map [v]',
        '-map [a]',
        '-t', duracaoFinal,
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart'
      ])
      .on('end', () => {
        logger.info(`[VIDEO PRO] ✅ Vídeo final montado`);
        resolve(outputPath);
      })
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

/**
 * Corta vídeo para duração específica
 */
function cortarVideo(input, output, duracao) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .duration(duracao)
      .outputOptions('-c copy')
      .on('end', resolve)
      .on('error', reject)
      .save(output);
  });
}

/**
 * Obtém duração do arquivo de mídia
 */
function getDuracao(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

export default { gerarVideoProfissional, CENARIOS };
