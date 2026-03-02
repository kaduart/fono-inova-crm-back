/**
 * 🎬 HeyGen Service — Geração de vídeo talking head
 * 
 * Integração com API HeyGen v2
 * - Múltiplos avatares (1 por profissional)
 * - Download automático do MP4
 * - Polling de status
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = process.env.HEYGEN_API_KEY;
const BASE = 'https://api.heygen.com';
const HEADERS = { 
  'X-Api-Key': API_KEY, 
  'Content-Type': 'application/json' 
};

// ─── Configuração de Avatares (preencher via .env) ─────────────────────
// 🎙️ Voice IDs HeyGen v2 válidos (Portuguese - Brasil)
// Use /api/videos/voices para listar vozes disponíveis
// 🎙️ Voice IDs HeyGen - Voz do seu avatar (português)
export const AVATARES = {
  fono_ana: { 
    avatar_id: process.env.HEYGEN_AVATAR_FONO   || 'a8385a99a1334225819315169e252107', 
    voice_id:  process.env.HEYGEN_VOICE_FONO    || 'e0aefdc326f34a71afddae5cdae32e5a'
  },
  psico_bia: { 
    avatar_id: process.env.HEYGEN_AVATAR_PSICO  || 'a8385a99a1334225819315169e252107', 
    voice_id:  process.env.HEYGEN_VOICE_PSICO   || 'e0aefdc326f34a71afddae5cdae32e5a'
  },
  to_carla: { 
    avatar_id: process.env.HEYGEN_AVATAR_TO     || 'a8385a99a1334225819315169e252107', 
    voice_id:  process.env.HEYGEN_VOICE_TO      || 'e0aefdc326f34a71afddae5cdae32e5a'
  },
  neuro_dani: { 
    avatar_id: process.env.HEYGEN_AVATAR_NEURO  || 'a8385a99a1334225819315169e252107', 
    voice_id:  process.env.HEYGEN_VOICE_NEURO   || 'e0aefdc326f34a71afddae5cdae32e5a'
  },
  fisio_edu: { 
    avatar_id: process.env.HEYGEN_AVATAR_FISIO  || 'a8385a99a1334225819315169e252107', 
    voice_id:  process.env.HEYGEN_VOICE_FISIO   || 'e0aefdc326f34a71afddae5cdae32e5a'
  },
  musico_fer: { 
    avatar_id: process.env.HEYGEN_AVATAR_MUSICO || 'a8385a99a1334225819315169e252107', 
    voice_id:  process.env.HEYGEN_VOICE_MUSICO  || 'e0aefdc326f34a71afddae5cdae32e5a'
  }
};

/**
 * Gera vídeo talking head e baixa o MP4
 * @param {Object} params
 * @param {string} params.profissional - 'fono_ana', 'psico_bia', etc.
 * @param {string} params.textoFala - Texto que o avatar vai falar
 * @param {string} params.titulo - Título do vídeo (para logs)
 * @returns {string} caminho absoluto do arquivo MP4 baixado
 */
export async function gerarVideo({ profissional, textoFala, titulo }) {
  if (!API_KEY) {
    throw new Error('HEYGEN_API_KEY não configurado');
  }

  const avatar = AVATARES[profissional];
  if (!avatar) {
    throw new Error(`Avatar não mapeado: ${profissional}. Opções: ${Object.keys(AVATARES).join(', ')}`);
  }

  logger.info(`[HEYGEN] Gerando: "${titulo}" | avatar: ${profissional}`);
  logger.info(`[HEYGEN] Avatar config: ${avatar.avatar_id} | Voice: ${avatar.voice_id}`);
  logger.info(`[HEYGEN] Texto (${textoFala.length} chars): ${textoFala.substring(0, 100)}...`);

  // Validar texto
  if (!textoFala || textoFala.trim().length < 10) {
    throw new Error('Texto muito curto para gerar vídeo (mínimo 10 caracteres)');
  }

  // 1. Construir configuração de voz (sempre requer voice_id na v2)
  const voiceConfig = {
    type:       'text',
    input_text: textoFala,
    voice_id:   avatar.voice_id,
    speed:      0.95
  };

  // 2. Disparar geração
  const { data: createRes } = await axios.post(`${BASE}/v2/video/generate`, {
    video_inputs: [{
      character: {
        type:         'avatar',
        avatar_id:    avatar.avatar_id,
        avatar_style: 'normal'
      },
      voice: voiceConfig,
      background: { 
        type:  'color', 
        value: '#FFFFFF' 
      }
    }],
    dimension:    { width: 1080, height: 1920 },
    aspect_ratio: '9:16'
  }, { headers: HEADERS });

  if (!createRes.data?.video_id) {
    throw new Error(`HeyGen não retornou video_id: ${JSON.stringify(createRes)}`);
  }

  const videoId = createRes.data.video_id;
  logger.info(`[HEYGEN] video_id: ${videoId} — polling iniciado`);

  // 2. Polling até conclusão (10 min max)
  const videoUrl = await _aguardarConclusao(videoId);

  // 3. Download do MP4
  const filePath = await _baixarVideo(videoUrl, videoId);
  logger.info(`[HEYGEN] ✅ Baixado: ${filePath}`);

  return filePath;
}

/**
 * Polling de status do vídeo
 */
async function _aguardarConclusao(videoId, maxTentativas = 60, intervaloMs = 10000) {
  for (let i = 1; i <= maxTentativas; i++) {
    await _sleep(intervaloMs);

    try {
      const { data } = await axios.get(
        `${BASE}/v1/video_status.get?video_id=${videoId}`,
        { headers: HEADERS }
      );

      const { status, video_url, thumbnail_url, error } = data.data || {};
      logger.info(`[HEYGEN] status: ${status} (${i}/${maxTentativas})`);

      if (status === 'completed' && video_url) {
        return video_url;
      }
      
      if (status === 'failed') {
        // 🔥 FIX: Melhor tratamento de erro
        let errorDetail;
        if (error) {
          if (typeof error === 'object') {
            errorDetail = JSON.stringify(error);
          } else {
            errorDetail = String(error);
          }
        } else {
          errorDetail = 'sem detalhe';
        }
        logger.error(`[HEYGEN] Falha no vídeo ${videoId}: ${errorDetail}`);
        throw new Error(`HeyGen falhou: ${errorDetail}`);
      }
    } catch (err) {
      // Se for erro de network, continua tentando
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        logger.warn(`[HEYGEN] Erro de conexão, tentando novamente...`);
        continue;
      }
      throw err;
    }
  }
  
  throw new Error(`HeyGen timeout após ${(maxTentativas * intervaloMs) / 60000} min`);
}

/**
 * Baixa o vídeo do HeyGen para o servidor local
 */
async function _baixarVideo(url, videoId) {
  const dir = path.resolve(__dirname, '../../tmp/videos/raw');
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `heygen_${videoId}.mp4`);
  
  const res = await axios.get(url, { 
    responseType: 'stream',
    timeout: 120000  // 2 minutos timeout
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    res.data.pipe(writer);
    
    let downloaded = 0;
    res.data.on('data', (chunk) => {
      downloaded += chunk.length;
      // Log a cada 10MB
      if (downloaded % (10 * 1024 * 1024) < chunk.length) {
        logger.info(`[HEYGEN] Download: ${(downloaded / 1024 / 1024).toFixed(1)}MB`);
      }
    });
    
    writer.on('finish', () => {
      const stats = fs.statSync(filePath);
      logger.info(`[HEYGEN] Download completo: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
      resolve();
    });
    writer.on('error', reject);
  });

  return filePath;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export default { gerarVideo, AVATARES };
