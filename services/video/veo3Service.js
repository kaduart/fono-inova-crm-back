/**
 * 🎬 Google Veo 3.0 — Geração de vídeo cinematográfico com áudio nativo
 *
 * Diferencial do Veo 3 vs Veo 2:
 * - Gera vídeo COM áudio ambiente natural (sons de crianças, clínica, etc.)
 * - Qualidade visual superior
 * - generateAudio: true → sons sincronizados com a cena
 *
 * Setup: GOOGLE_AI_API_KEY no .env
 * Modelo: veo-3.0-generate-preview
 */

import { GoogleGenAI } from '@google/genai';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import path from 'path';
import https from 'https';
import axios from 'axios';
import logger from '../../utils/logger.js';
import { buildScenePrompt, buildCustomPrompt } from './veoService.js';

// Fix WSL2: força IPv4 no download do vídeo (evita fetch failed do undici)
const ipv4HttpsAgent = new https.Agent({ family: 4 });

const VEO3_MODEL = 'veo-3.0-generate-preview';

export class Veo3Service {
  constructor() {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_AI_API_KEY não configurado. Acesse aistudio.google.com para obter gratuitamente.');
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Gera vídeo com Google Veo 3.0 (com áudio nativo)
   *
   * @param {string} especialidadeId - ID da especialidade
   * @param {string|null} temaCustom - Tema personalizado (opcional, usa cenas padrão se null)
   * @param {Object} options
   * @param {number}  options.durationSeconds - Duração do clip (5 ou 8, padrão: 8)
   * @param {string}  options.aspectRatio     - '9:16' para Reels/Stories (padrão)
   * @param {number}  options.clipIndex       - Índice da cena (0-based)
   * @param {string}  options.intensidade     - 'leve' | 'moderado' | 'forte' | 'viral'
   * @param {boolean} options.generateAudio   - Incluir áudio ambiente (padrão: true)
   * @returns {{ url: string, duration: number, bytes: number, provider: string, hasNativeAudio: boolean }}
   */
  async gerarVideo(especialidadeId, temaCustom = null, options = {}) {
    const {
      durationSeconds = 8,
      aspectRatio = '9:16',
      clipIndex = 0,
      intensidade = 'moderado',
      generateAudio = true
    } = options;

    const prompt = temaCustom
      ? buildCustomPrompt(temaCustom, especialidadeId, intensidade)
      : buildScenePrompt(especialidadeId, clipIndex, intensidade);

    logger.info(`[VEO3 SERVICE] 🎬 Iniciando — ${especialidadeId} — clip ${clipIndex + 1} — ${durationSeconds}s ${aspectRatio} — áudio:${generateAudio}`);
    logger.info(`[VEO3 SERVICE] Cena: ${prompt.substring(0, 120)}...`);

    let operation = await this.ai.models.generateVideos({
      model: VEO3_MODEL,
      prompt,
      config: {
        aspectRatio,
        durationSeconds,
        personGeneration: 'allow_all',
        numberOfVideos: 1,
        generateAudio
      }
    });

    // Polling até completar (~3-5 min)
    const MAX_WAIT_MS = 10 * 60 * 1000;  // Veo 3 pode demorar um pouco mais
    const POLL_INTERVAL_MS = 15_000;
    const startTime = Date.now();

    while (!operation.done) {
      if (Date.now() - startTime > MAX_WAIT_MS) {
        throw new Error('[VEO3 SERVICE] Timeout: vídeo não gerado em 10 minutos');
      }
      logger.info(`[VEO3 SERVICE] ⏳ Aguardando geração... (~${Math.round((Date.now() - startTime) / 1000)}s)`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      // Retry no polling para tolerar erros de rede transitórios (WSL2 IPv6/IPv4)
      let pollTentativa = 0;
      while (true) {
        try {
          operation = await this.ai.operations.getVideosOperation({ operation });
          break;
        } catch (pollErr) {
          const isRede =
            pollErr?.message?.includes('fetch failed') ||
            pollErr?.message?.includes('ECONNRESET') ||
            pollErr?.message?.includes('ETIMEDOUT');
          if (isRede && pollTentativa < 4) {
            const waitMs = (pollTentativa + 1) * 5_000;
            logger.warn(`[VEO3 SERVICE] ⚠️ Erro de rede no polling (tentativa ${pollTentativa + 1}/4), aguardando ${waitMs / 1000}s...`);
            await new Promise(r => setTimeout(r, waitMs));
            pollTentativa++;
          } else {
            throw pollErr;
          }
        }
      }
    }

    if (operation.error) {
      throw new Error(`[VEO3 SERVICE] Erro da API Veo 3: ${operation.error.message}`);
    }

    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (!generatedVideo?.video?.uri) {
      throw new Error('[VEO3 SERVICE] Nenhum vídeo retornado pela API');
    }

    logger.info(`[VEO3 SERVICE] ✅ Vídeo gerado! Baixando...`);

    // Download via axios com IPv4 (evita fetch failed no WSL2)
    const videoUri = generatedVideo.video.uri;
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    const videoResponse = await axios.get(`${videoUri}&key=${apiKey}`, {
      responseType: 'arraybuffer',
      httpsAgent: ipv4HttpsAgent
    });

    // Salvar temporário
    const tempPath = path.join('/tmp', `veo3_${Date.now()}.mp4`);
    fs.writeFileSync(tempPath, Buffer.from(videoResponse.data));

    // Upload para Cloudinary
    logger.info(`[VEO3 SERVICE] ☁️ Enviando para Cloudinary...`);
    const cloudinaryResult = await cloudinary.uploader.upload(tempPath, {
      resource_type: 'video',
      folder: 'fono-inova/ai-videos/veo3',
      public_id: `veo3_${especialidadeId}_${Date.now()}`,
      overwrite: false
    });

    // Limpar arquivo temporário
    try { fs.unlinkSync(tempPath); } catch { /* ignora */ }

    logger.info(`[VEO3 SERVICE] 🎉 Sucesso! URL: ${cloudinaryResult.secure_url.substring(0, 60)}...`);

    return {
      url: cloudinaryResult.secure_url,
      duration: cloudinaryResult.duration || durationSeconds,
      bytes: cloudinaryResult.bytes,
      provider: 'veo-3.0',
      hasNativeAudio: generateAudio
    };
  }
}

/**
 * Verificar se Veo 3 está configurado
 */
export function isVeo3Configured() {
  return Boolean(process.env.GOOGLE_AI_API_KEY);
}

export default Veo3Service;
