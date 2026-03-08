/**
 * 🎬 Google Veo 3.1 — Geração de vídeo cinematográfico
 *
 * Usa Google AI Studio (grátis: 50 vídeos/dia, 1500/mês)
 * Migrar para Vertex AI se passar de 1500/mês ou precisar 4K
 *
 * Setup: GOOGLE_AI_API_KEY no .env (gratuito em aistudio.google.com)
 */

import { GoogleGenAI } from '@google/genai';
import cloudinary from 'cloudinary';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

// Prompts cinematográficos por especialidade
const PROMPTS_ESPECIALIDADE = {
  fonoaudiologia: `Close-up cinematográfico de terapeuta auxiliando criança de 5 anos em exercício de sopro com bolhas,
    sessão de fonoaudiologia com espelho logopédico, ambiente clínico moderno com paredes verde claro e branco,
    iluminação natural difusa vindo de janela lateral, câmera estável em shoulder height,
    movimento suave de slow zoom-in nos rostos, profundidade de campo rasa,
    estilo documental médico high-end, atmosfera acolhedora, 24fps`,

  psicologia: `Terapeuta e adolescente em sessão terapêutica acolhedora, consultório moderno com plantas verdes,
    luz natural suave, câmera estável com rack focus no rosto da criança expressando alívio,
    cores calmas azul e bege, atmosfera segura e profissional, estilo documental emocional, 24fps`,

  terapia_ocupacional: `Criança realizando atividade de coordenação motora fina com materiais pedagógicos coloridos,
    terapeuta ocupacional guiando com mãos gentis, sala terapêutica clean com luz natural,
    câmera overhead com tilt suave para rosto da criança sorrindo, movimento expressivo das mãos,
    cores vibrantes e ambiente estimulante, estilo documental educacional, 24fps`,

  fisioterapia: `Fisioterapeuta pediátrico auxiliando criança em exercício de reabilitação com equipamentos coloridos,
    clínica moderna clara, iluminação profissional, câmera dolly suave acompanhando movimento,
    criança demonstrando superação e sorrindo, atmosfera motivadora, estilo documental clínico, 24fps`,

  psicomotricidade: `Criança pequena explorando movimento corporal em sala de psicomotricidade com tatames coloridos,
    psicomotricista observando e incentivando, ambiente lúdico e seguro, luz difusa suave,
    câmera wide seguindo movimento livre da criança, expressão de alegria e descoberta,
    estilo documental leve e alegre, 24fps`,

  freio_lingual: `Cirurgião-dentista pediátrico em clínica infantil com decoração acolhedora, equipamentos modernos,
    criança relaxada e confiante, luz clínica profissional com elementos suaves,
    câmera close-up em expressões tranquilas, ambiente clean e seguro,
    estilo documental médico profissional, 24fps`,

  neuropsicologia: `Neuropsicóloga aplicando avaliação lúdica com criança em consultório com iluminação quente,
    materiais de avaliação coloridos espalhados sobre mesa, câmera overhead capturando mãos em atividade,
    rack focus para rosto concentrado da criança, atmosfera estimulante e segura,
    estilo documental científico acessível, 24fps`,

  psicopedagogia: `Psicopedagoga e criança trabalhando com materiais de leitura e escrita criativos,
    sala de atendimento organizada e colorida, luz natural de janela, criança tendo insight expressando alegria,
    câmera close-up no momento de descoberta, atmosfera de aprendizado e conquista,
    estilo documental educacional inspirador, 24fps`,

  musicoterapia: `Musicoterapeuta e criança com autismo tocando instrumentos musicais simples juntos,
    sala de musicoterapia com instrumentos coloridos, luz quente e acolhedora, câmera capturando conexão entre os dois,
    criança totalmente engajada e sorrindo, movimento rítmico das mãos, atmosfera mágica e terapêutica,
    estilo documental emocional com foco em inclusão, 24fps`
};

// Template de prompt para tema personalizado
const buildCustomPrompt = (tema, especialidade) => {
  const base = PROMPTS_ESPECIALIDADE[especialidade] || PROMPTS_ESPECIALIDADE.fonoaudiologia;
  return `${tema}. ${base.split(',').slice(2).join(',')}`;
};

export class VeoService {
  constructor() {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_AI_API_KEY não configurado. Acesse aistudio.google.com para obter gratuitamente.');
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Gera vídeo com Google Veo 3.1
   * @param {string} especialidadeId - ID da especialidade (fonoaudiologia, psicologia, etc.)
   * @param {string} [temaCustom] - Tema personalizado (opcional — se não informado usa prompt padrão)
   * @param {Object} options
   * @param {number} options.durationSeconds - Duração em segundos (padrão: 8, máx grátis: 8)
   * @param {string} options.aspectRatio - '9:16' para Reels/Stories, '16:9' para YouTube
   * @returns {{ url: string, duration: number, bytes: number }}
   */
  async gerarVideo(especialidadeId, temaCustom = null, options = {}) {
    const {
      durationSeconds = 8,
      aspectRatio = '9:16'
    } = options;

    const prompt = temaCustom
      ? buildCustomPrompt(temaCustom, especialidadeId)
      : PROMPTS_ESPECIALIDADE[especialidadeId] || PROMPTS_ESPECIALIDADE.fonoaudiologia;

    logger.info(`[VEO SERVICE] 🎬 Iniciando geração — ${especialidadeId} — ${durationSeconds}s ${aspectRatio}`);
    logger.info(`[VEO SERVICE] Prompt (primeiros 120 chars): ${prompt.substring(0, 120)}...`);

    let operation;
    try {
      operation = await this.ai.models.generateVideos({
        model: 'veo-3.0-generate-preview',
        prompt,
        config: {
          resolution: '1080p',
          aspectRatio,
          durationSeconds,
          generateAudio: true  // Gera som ambiente natural
        }
      });
    } catch (err) {
      // Fallback para modelo sem audio se necessário
      logger.warn(`[VEO SERVICE] Tentativa 1 falhou, tentando sem áudio: ${err.message}`);
      operation = await this.ai.models.generateVideos({
        model: 'veo-3.0-generate-preview',
        prompt,
        config: {
          resolution: '1080p',
          aspectRatio,
          durationSeconds,
          generateAudio: false
        }
      });
    }

    // Polling até completar (~3-5 min)
    const MAX_WAIT_MS = 8 * 60 * 1000; // 8 minutos máximo
    const POLL_INTERVAL_MS = 15_000;   // 15s entre checks
    const startTime = Date.now();

    while (!operation.done) {
      if (Date.now() - startTime > MAX_WAIT_MS) {
        throw new Error('[VEO SERVICE] Timeout: vídeo não gerado em 8 minutos');
      }
      logger.info(`[VEO SERVICE] ⏳ Aguardando geração... (~${Math.round((Date.now() - startTime) / 1000)}s)`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      await operation.poll();
    }

    if (operation.error) {
      throw new Error(`[VEO SERVICE] Erro da API Veo: ${operation.error.message}`);
    }

    const generatedVideo = operation.response?.generated_videos?.[0];
    if (!generatedVideo?.video) {
      throw new Error('[VEO SERVICE] Nenhum vídeo retornado pela API');
    }

    logger.info(`[VEO SERVICE] ✅ Vídeo gerado! Baixando...`);

    // Download do vídeo
    const videoBuffer = await this.ai.files.download({ file: generatedVideo.video });

    // Salvar temporário
    const tempPath = path.join('/tmp', `veo_${Date.now()}.mp4`);
    if (Buffer.isBuffer(videoBuffer)) {
      fs.writeFileSync(tempPath, videoBuffer);
    } else if (videoBuffer instanceof ArrayBuffer) {
      fs.writeFileSync(tempPath, Buffer.from(videoBuffer));
    } else {
      // Se for Uint8Array ou similar
      fs.writeFileSync(tempPath, Buffer.from(videoBuffer));
    }

    // Upload para Cloudinary
    logger.info(`[VEO SERVICE] ☁️ Enviando para Cloudinary...`);
    const cloudinaryResult = await cloudinary.v2.uploader.upload(tempPath, {
      resource_type: 'video',
      folder: 'fono-inova/ai-videos/veo',
      public_id: `veo_${especialidadeId}_${Date.now()}`,
      overwrite: false
    });

    // Limpar arquivo temporário
    try { fs.unlinkSync(tempPath); } catch { /* ignora */ }

    logger.info(`[VEO SERVICE] 🎉 Sucesso! URL: ${cloudinaryResult.secure_url.substring(0, 60)}...`);

    return {
      url: cloudinaryResult.secure_url,
      duration: cloudinaryResult.duration || durationSeconds,
      bytes: cloudinaryResult.bytes,
      provider: 'veo-3.1'
    };
  }
}

/**
 * Verificar se Veo está configurado
 */
export function isVeoConfigured() {
  return Boolean(process.env.GOOGLE_AI_API_KEY);
}

export default VeoService;
