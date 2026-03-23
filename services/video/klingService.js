/**
 * Kling AI — Geração de vídeo cinematográfico
 *
 * Usa Kling AI API (klingai.com)
 * Setup: KLING_ACCESS_KEY_ID + KLING_ACCESS_KEY_SECRET no .env
 */

import jwt from 'jsonwebtoken';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import path from 'path';
import https from 'https';
import axios from 'axios';
import logger from '../../utils/logger.js';
import { buildScenePrompt, buildCustomPrompt } from './veoService.js';

const ipv4HttpsAgent = new https.Agent({ family: 4 });
const KLING_BASE_URL = 'https://api.klingai.com';
export const CLIP_DURATION = 10; // Kling: 5s ou 10s por clip

function gerarToken() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: process.env.KLING_ACCESS_KEY_ID, exp: now + 1800, nbf: now - 5 },
    process.env.KLING_ACCESS_KEY_SECRET,
    { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } }
  );
}

export class KlingService {
  /**
   * Gera um clip de vídeo com Kling AI
   * @param {string} especialidadeId
   * @param {string|null} temaCustom
   * @param {Object} options
   * @param {number} options.clipIndex - índice do clip (0-based)
   * @returns {{ url: string, duration: number, bytes: number, provider: string }}
   */
  async gerarVideo(especialidadeId, temaCustom = null, options = {}) {
    const { clipIndex = 0 } = options;

    const prompt = temaCustom
      ? buildCustomPrompt(temaCustom, especialidadeId)
      : buildScenePrompt(especialidadeId, clipIndex);

    logger.info(`[KLING SERVICE] Iniciando geração — ${especialidadeId} — clip ${clipIndex + 1} — ${CLIP_DURATION}s 9:16`);
    logger.info(`[KLING SERVICE] Cena: ${prompt.substring(0, 120)}...`);

    // 1. Criar task
    const token = gerarToken();
    const createRes = await axios.post(
      `${KLING_BASE_URL}/v1/videos/text2video`,
      {
        model_name: 'kling-v2-master',
        prompt,
        negative_prompt: 'blurry, low quality, distorted, watermark, text, subtitles',
        cfg_scale: 0.5,
        mode: 'std',
        aspect_ratio: '9:16',
        duration: String(CLIP_DURATION)
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        httpsAgent: ipv4HttpsAgent
      }
    );

    const taskId = createRes.data?.data?.task_id;
    if (!taskId) {
      throw new Error(`[KLING SERVICE] task_id não retornado: ${JSON.stringify(createRes.data)}`);
    }
    logger.info(`[KLING SERVICE] Task criada: ${taskId}`);

    // 2. Polling até completar
    const MAX_WAIT_MS = 10 * 60 * 1000;
    const POLL_INTERVAL_MS = 15_000;
    const startTime = Date.now();

    while (true) {
      if (Date.now() - startTime > MAX_WAIT_MS) {
        throw new Error('[KLING SERVICE] Timeout: vídeo não gerado em 10 minutos');
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      logger.info(`[KLING SERVICE] Polling task ${taskId}... (~${Math.round((Date.now() - startTime) / 1000)}s)`);

      const pollToken = gerarToken();
      const statusRes = await axios.get(
        `${KLING_BASE_URL}/v1/videos/text2video/${taskId}`,
        {
          headers: { Authorization: `Bearer ${pollToken}` },
          httpsAgent: ipv4HttpsAgent
        }
      );

      const task = statusRes.data?.data;
      const status = task?.task_status;

      if (status === 'succeed') {
        const videoUrl = task?.task_result?.videos?.[0]?.url;
        if (!videoUrl) throw new Error('[KLING SERVICE] URL do vídeo não retornada na resposta');

        logger.info(`[KLING SERVICE] Gerado! Baixando...`);

        // 3. Download
        const tempPath = path.join('/tmp', `kling_${Date.now()}.mp4`);
        const videoResponse = await axios.get(videoUrl, {
          responseType: 'arraybuffer',
          httpsAgent: ipv4HttpsAgent
        });
        fs.writeFileSync(tempPath, Buffer.from(videoResponse.data));

        // 4. Upload para Cloudinary
        logger.info(`[KLING SERVICE] Enviando para Cloudinary...`);
        const uploadResult = await cloudinary.uploader.upload(tempPath, {
          resource_type: 'video',
          folder: 'fono-inova/ai-videos/kling',
          public_id: `kling_${especialidadeId}_${Date.now()}`,
          overwrite: false
        });

        try { fs.unlinkSync(tempPath); } catch {}

        logger.info(`[KLING SERVICE] Sucesso! URL: ${uploadResult.secure_url.substring(0, 60)}...`);

        return {
          url: uploadResult.secure_url,
          duration: CLIP_DURATION,
          bytes: uploadResult.bytes,
          provider: 'kling'
        };
      }

      if (status === 'failed') {
        throw new Error(`[KLING SERVICE] Geração falhou: ${task?.task_status_msg || 'erro desconhecido'}`);
      }

      // status === 'processing' | 'submitted' → continua polling
    }
  }
}

export function isKlingConfigured() {
  return Boolean(process.env.KLING_ACCESS_KEY_ID && process.env.KLING_ACCESS_KEY_SECRET);
}

export default KlingService;
