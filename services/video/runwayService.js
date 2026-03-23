/**
 * Runway Gen-3 Alpha Turbo — Geração de vídeo cinematográfico
 *
 * Usa Runway API (runwayml.com) — compra self-service por cartão
 * Setup: RUNWAY_API_KEY no .env
 */

import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import path from 'path';
import https from 'https';
import axios from 'axios';
import logger from '../../utils/logger.js';
import { buildScenePrompt, buildCustomPrompt } from './veoService.js';

const ipv4HttpsAgent = new https.Agent({ family: 4 });
const RUNWAY_BASE_URL = 'https://api.runwayml.com/v1';
export const CLIP_DURATION = 10; // Runway Gen-3: 5s ou 10s por clip

export class RunwayService {
  constructor() {
    this.apiKey = process.env.RUNWAY_API_KEY;
    if (!this.apiKey) {
      throw new Error('RUNWAY_API_KEY não configurado.');
    }
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06'
    };
  }

  /**
   * Gera um clip de vídeo com Runway Gen-3 Alpha Turbo
   * @param {string} especialidadeId
   * @param {string|null} temaCustom
   * @param {Object} options
   * @param {number} options.clipIndex
   * @returns {{ url: string, duration: number, bytes: number, provider: string }}
   */
  async gerarVideo(especialidadeId, temaCustom = null, options = {}) {
    const { clipIndex = 0 } = options;

    const promptText = temaCustom
      ? buildCustomPrompt(temaCustom, especialidadeId)
      : buildScenePrompt(especialidadeId, clipIndex);

    logger.info(`[RUNWAY SERVICE] Iniciando geração — ${especialidadeId} — clip ${clipIndex + 1} — ${CLIP_DURATION}s 9:16`);
    logger.info(`[RUNWAY SERVICE] Prompt: ${promptText.substring(0, 120)}...`);

    // 1. Criar task text-to-video
    const createRes = await axios.post(
      `${RUNWAY_BASE_URL}/text_to_video`,
      {
        promptText,
        model: 'gen3a_turbo',
        duration: CLIP_DURATION,
        ratio: '768:1280'  // 9:16 para Reels
      },
      { headers: this.headers, httpsAgent: ipv4HttpsAgent }
    );

    const taskId = createRes.data?.id;
    if (!taskId) {
      throw new Error(`[RUNWAY SERVICE] task id não retornado: ${JSON.stringify(createRes.data)}`);
    }
    logger.info(`[RUNWAY SERVICE] Task criada: ${taskId}`);

    // 2. Polling
    const MAX_WAIT_MS = 10 * 60 * 1000;
    const POLL_INTERVAL_MS = 10_000;
    const startTime = Date.now();

    while (true) {
      if (Date.now() - startTime > MAX_WAIT_MS) {
        throw new Error('[RUNWAY SERVICE] Timeout: vídeo não gerado em 10 minutos');
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      logger.info(`[RUNWAY SERVICE] Polling task ${taskId}... (~${Math.round((Date.now() - startTime) / 1000)}s)`);

      const statusRes = await axios.get(
        `${RUNWAY_BASE_URL}/tasks/${taskId}`,
        { headers: this.headers, httpsAgent: ipv4HttpsAgent }
      );

      const task = statusRes.data;
      const status = task?.status;

      if (status === 'SUCCEEDED') {
        const videoUrl = task?.output?.[0];
        if (!videoUrl) throw new Error('[RUNWAY SERVICE] URL do vídeo não retornada na resposta');

        logger.info(`[RUNWAY SERVICE] Gerado! Baixando...`);

        // 3. Download
        const tempPath = path.join('/tmp', `runway_${Date.now()}.mp4`);
        const videoResponse = await axios.get(videoUrl, {
          responseType: 'arraybuffer',
          httpsAgent: ipv4HttpsAgent
        });
        fs.writeFileSync(tempPath, Buffer.from(videoResponse.data));

        // 4. Upload para Cloudinary
        logger.info(`[RUNWAY SERVICE] Enviando para Cloudinary...`);
        const uploadResult = await cloudinary.uploader.upload(tempPath, {
          resource_type: 'video',
          folder: 'fono-inova/ai-videos/runway',
          public_id: `runway_${especialidadeId}_${Date.now()}`,
          overwrite: false
        });

        try { fs.unlinkSync(tempPath); } catch {}

        logger.info(`[RUNWAY SERVICE] Sucesso! URL: ${uploadResult.secure_url.substring(0, 60)}...`);

        return {
          url: uploadResult.secure_url,
          duration: CLIP_DURATION,
          bytes: uploadResult.bytes,
          provider: 'runway'
        };
      }

      if (status === 'FAILED') {
        throw new Error(`[RUNWAY SERVICE] Geração falhou: ${task?.failure || task?.failureCode || 'erro desconhecido'}`);
      }

      // status === 'PENDING' | 'RUNNING' → continua polling
    }
  }
}

export function isRunwayConfigured() {
  return Boolean(process.env.RUNWAY_API_KEY);
}

export default RunwayService;
