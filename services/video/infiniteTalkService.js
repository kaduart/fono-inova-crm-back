/**
 * 🗣️ InfiniteTalk — Vídeo falante com sincronização labial
 *
 * GitHub: MeiGen-AI/InfiniteTalk
 * Providers:
 *   - Kie.ai    → KIEAI_API_KEY    ($0.015/s 480p, máx 15s/clip)
 *   - WaveSpeed → WAVESPEED_API_KEY ($0.03/s 480p, até 600s)
 *
 * Seleção automática:
 *   - áudio ≤ 15s  → Kie.ai (mais barato)
 *   - áudio > 15s  → WaveSpeed (suporta longo)
 *   - fallback      → se Kie falhar, tenta WaveSpeed automaticamente
 *
 * Setup .env:
 *   KIEAI_API_KEY=...
 *   WAVESPEED_API_KEY=...
 *   INFINITETALK_AVATAR_URL=...   (URL pública da foto do avatar da clínica)
 *   INFINITETALK_PROVIDER=kieai|wavespeed  (força provider, ignora auto-seleção)
 */

import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import path from 'path';
import https from 'https';
import logger from '../../utils/logger.js';

const ipv4HttpsAgent = new https.Agent({ family: 4 });

const KIEAI_BASE     = 'https://api.kie.ai/api/v1';
const WAVESPEED_BASE = 'https://api.wavespeed.ai/api/v3';
const KIEAI_MAX_AUDIO_S = 14; // margem segura abaixo de 15s

const DEFAULT_AVATAR_URL = process.env.INFINITETALK_AVATAR_URL || null;

export function isInfiniteTalkConfigured() {
  return Boolean(process.env.KIEAI_API_KEY || process.env.WAVESPEED_API_KEY);
}

// ─── UTILITÁRIO ───────────────────────────────────────────────────────────────

/**
 * Retorna a duração em segundos de um arquivo de áudio local
 */
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 0);
    });
  });
}

/**
 * Escolhe o provider ideal com base na duração do áudio e keys disponíveis.
 * Força o provider se INFINITETALK_PROVIDER estiver definido no .env.
 */
function escolherProvider(audioDurationSeconds) {
  const forced = (process.env.INFINITETALK_PROVIDER || '').toLowerCase();
  if (forced === 'kieai'     && process.env.KIEAI_API_KEY)     return 'kieai';
  if (forced === 'wavespeed' && process.env.WAVESPEED_API_KEY) return 'wavespeed';

  // Auto: áudio longo → WaveSpeed; curto → Kie (mais barato)
  if (audioDurationSeconds > KIEAI_MAX_AUDIO_S) {
    if (process.env.WAVESPEED_API_KEY) return 'wavespeed';
    if (process.env.KIEAI_API_KEY) {
      logger.warn(`[INFINITETALK] ⚠️ Áudio ${audioDurationSeconds.toFixed(1)}s excede limite Kie (${KIEAI_MAX_AUDIO_S}s) mas WAVESPEED_API_KEY não configurado. Usando Kie mesmo assim — pode falhar.`);
      return 'kieai';
    }
  }

  if (process.env.KIEAI_API_KEY)     return 'kieai';
  if (process.env.WAVESPEED_API_KEY) return 'wavespeed';
  return null;
}

// ─── KIE.AI ───────────────────────────────────────────────────────────────────

async function kieaiSubmit({ imageUrl, audioUrl, prompt, resolution }) {
  const res = await axios.post(
    `${KIEAI_BASE}/jobs/createTask`,
    {
      model: 'infinitalk/from-audio',
      input: {
        image_url: imageUrl,
        audio_url: audioUrl,
        prompt: prompt || 'A professional person speaks clearly and naturally to the camera.',
        resolution,
        seed: Math.floor(Math.random() * 990000) + 10000
      }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.KIEAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      httpsAgent: ipv4HttpsAgent
    }
  );

  if (res.data?.code !== 200 || !res.data?.data?.taskId) {
    throw new Error(`[INFINITETALK/KIEAI] Erro ao criar task: ${JSON.stringify(res.data)}`);
  }
  return res.data.data.taskId;
}

async function kieaiPoll(taskId, maxWaitMs = 5 * 60 * 1000) {
  const INTERVAL = 10_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, INTERVAL));

    const res = await axios.get(
      `${KIEAI_BASE}/jobs/recordInfo?taskId=${taskId}`,
      {
        headers: { Authorization: `Bearer ${process.env.KIEAI_API_KEY}` },
        httpsAgent: ipv4HttpsAgent
      }
    );

    const data = res.data?.data;
    if (!data) throw new Error(`[INFINITETALK/KIEAI] Resposta inválida no polling`);

    const state = data.state;
    logger.info(`[INFINITETALK/KIEAI] ${taskId} — ${state} (~${Math.round((Date.now() - start) / 1000)}s)`);

    if (state === 'success') {
      const result = JSON.parse(data.resultJson || '{}');
      const url = result.resultUrls?.[0];
      if (!url) throw new Error(`[INFINITETALK/KIEAI] Sem URL no resultado`);
      return url;
    }
    if (state === 'fail') {
      throw new Error(`[INFINITETALK/KIEAI] Falhou: ${data.failMsg || 'erro desconhecido'}`);
    }
  }

  throw new Error(`[INFINITETALK/KIEAI] Timeout: task ${taskId} não concluiu em ${maxWaitMs / 60000} min`);
}

// ─── WAVESPEED ────────────────────────────────────────────────────────────────

async function wavespeedSubmit({ imageUrl, audioUrl, prompt, resolution }) {
  const res = await axios.post(
    `${WAVESPEED_BASE}/wavespeed-ai/infinitetalk`,
    {
      image: imageUrl,
      audio: audioUrl,
      prompt: prompt || 'A professional person speaks clearly and naturally to the camera.',
      resolution,
      seed: -1
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}`,
        'Content-Type': 'application/json'
      },
      httpsAgent: ipv4HttpsAgent
    }
  );

  const requestId = res.data?.data?.id;
  if (!requestId) {
    throw new Error(`[INFINITETALK/WAVESPEED] Erro ao criar task: ${JSON.stringify(res.data)}`);
  }
  return requestId;
}

async function wavespeedPoll(requestId, maxWaitMs = 8 * 60 * 1000) {
  const INTERVAL = 10_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, INTERVAL));

    const res = await axios.get(
      `${WAVESPEED_BASE}/predictions/${requestId}/result`,
      {
        headers: { Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}` },
        httpsAgent: ipv4HttpsAgent
      }
    );

    const data = res.data?.data;
    const status = data?.status;
    logger.info(`[INFINITETALK/WAVESPEED] ${requestId} — ${status} (~${Math.round((Date.now() - start) / 1000)}s)`);

    if (status === 'completed') {
      const url = data.outputs?.[0];
      if (!url) throw new Error(`[INFINITETALK/WAVESPEED] Sem URL no resultado`);
      return url;
    }
    if (status === 'failed') {
      throw new Error(`[INFINITETALK/WAVESPEED] Falhou: ${data.error || 'erro desconhecido'}`);
    }
  }

  throw new Error(`[INFINITETALK/WAVESPEED] Timeout: request ${requestId} não concluiu em ${maxWaitMs / 60000} min`);
}

// ─── GERAÇÃO COM RETRY + FALLBACK ─────────────────────────────────────────────

/**
 * Tenta gerar o vídeo no provider escolhido.
 * Se falhar, tenta no provider alternativo (fallback automático).
 */
async function gerarComFallback({ imageUrl, audioUrl, prompt, resolution, providerPreferido }) {
  const ordem = providerPreferido === 'kieai'
    ? ['kieai', 'wavespeed']
    : ['wavespeed', 'kieai'];

  // Filtra providers que têm API key configurada
  const disponíveis = ordem.filter(p =>
    (p === 'kieai' && process.env.KIEAI_API_KEY) ||
    (p === 'wavespeed' && process.env.WAVESPEED_API_KEY)
  );

  let ultimoErro;

  for (const provider of disponíveis) {
    const tentativas = 2;
    for (let t = 1; t <= tentativas; t++) {
      try {
        logger.info(`[INFINITETALK] Tentativa ${t}/${tentativas} — provider: ${provider}`);

        if (provider === 'kieai') {
          const taskId = await kieaiSubmit({ imageUrl, audioUrl, prompt, resolution });
          logger.info(`[INFINITETALK/KIEAI] ✅ Task: ${taskId}`);
          const url = await kieaiPoll(taskId);
          return { url, provider };
        } else {
          const requestId = await wavespeedSubmit({ imageUrl, audioUrl, prompt, resolution });
          logger.info(`[INFINITETALK/WAVESPEED] ✅ Request: ${requestId}`);
          const url = await wavespeedPoll(requestId);
          return { url, provider };
        }
      } catch (err) {
        ultimoErro = err;
        logger.warn(`[INFINITETALK] ⚠️ Falha (provider=${provider}, tentativa=${t}): ${err.message}`);
        if (t < tentativas) await new Promise(r => setTimeout(r, 5_000));
      }
    }

    // Esgotou tentativas nesse provider — tenta o próximo se disponível
    if (disponíveis.indexOf(provider) < disponíveis.length - 1) {
      logger.warn(`[INFINITETALK] ⚠️ Falhou em ${provider} após ${tentativas} tentativas. Tentando fallback...`);
    }
  }

  throw ultimoErro || new Error('[INFINITETALK] Todos os providers falharam');
}

// ─── SERVICE PRINCIPAL ────────────────────────────────────────────────────────

export class InfiniteTalkService {
  /**
   * Gera vídeo falante com sincronização labial
   *
   * @param {string} audioUrl         - URL pública do áudio TTS
   * @param {Object} options
   * @param {string} options.imageUrl      - URL do avatar (usa DEFAULT_AVATAR_URL se omitido)
   * @param {string} options.audioLocalPath - Caminho local do áudio (para medir duração)
   * @param {string} options.prompt        - Descrição da cena/estilo
   * @param {string} options.resolution    - '480p' | '720p'
   * @param {string} options.especialidade - Para nomear o arquivo no Cloudinary
   * @returns {{ url: string, duration: number, bytes: number, provider: string }}
   */
  async gerarVideo(audioUrl, options = {}) {
    const {
      imageUrl = DEFAULT_AVATAR_URL,
      audioLocalPath = null,
      prompt = '',
      resolution = '480p',
      especialidade = 'geral'
    } = options;

    if (!imageUrl) {
      throw new Error('[INFINITETALK] INFINITETALK_AVATAR_URL não configurado e nenhum imageUrl fornecido.');
    }

    if (!isInfiniteTalkConfigured()) {
      throw new Error('[INFINITETALK] Nenhuma API key configurada. Defina KIEAI_API_KEY ou WAVESPEED_API_KEY no .env');
    }

    // Detecta duração do áudio (se arquivo local disponível) para escolher provider ideal
    let audioDuration = 0;
    if (audioLocalPath && fs.existsSync(audioLocalPath)) {
      try {
        audioDuration = await getAudioDuration(audioLocalPath);
        logger.info(`[INFINITETALK] Duração do áudio: ${audioDuration.toFixed(1)}s`);
      } catch {
        logger.warn(`[INFINITETALK] Não foi possível medir duração do áudio — usando provider padrão`);
      }
    }

    const providerIdeal = escolherProvider(audioDuration);
    logger.info(`[INFINITETALK] 🗣️ Provider escolhido: ${providerIdeal} | áudio: ${audioDuration.toFixed(1)}s | resolução: ${resolution}`);

    // Geração com retry automático e fallback entre providers
    const { url: videoUrl, provider: providerUsado } = await gerarComFallback({
      imageUrl,
      audioUrl,
      prompt,
      resolution,
      providerPreferido: providerIdeal
    });

    logger.info(`[INFINITETALK] ✅ Vídeo gerado via ${providerUsado}! Fazendo upload para Cloudinary...`);

    // Download e re-upload para Cloudinary
    const tempPath = path.join('/tmp', `infinitetalk_${Date.now()}.mp4`);
    const videoResponse = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      httpsAgent: ipv4HttpsAgent,
      timeout: 60_000
    });
    fs.writeFileSync(tempPath, Buffer.from(videoResponse.data));

    const cloudinaryResult = await cloudinary.uploader.upload(tempPath, {
      resource_type: 'video',
      folder: 'fono-inova/ai-videos/infinitetalk',
      public_id: `infinitetalk_${especialidade}_${Date.now()}`,
      overwrite: false
    });

    try { fs.unlinkSync(tempPath); } catch {}

    logger.info(`[INFINITETALK] 🎉 Concluído: ${cloudinaryResult.secure_url.substring(0, 60)}...`);

    return {
      url: cloudinaryResult.secure_url,
      duration: cloudinaryResult.duration,
      bytes: cloudinaryResult.bytes,
      provider: `infinitetalk-${providerUsado}`
    };
  }
}

export default InfiniteTalkService;
