/**
 * 🎬 Video Worker — Processa jobs de geração de vídeo
 * 
 * Pipeline completo:
 * 1. ZEUS → Gerar roteiro estruturado
 * 2. HeyGen → Gerar vídeo talking head
 * 3. FFmpeg → Pós-produção (legendas, logo, CTA, música)
 * 4. Meta → Publicar campanha (opcional)
 */

import { Worker } from 'bullmq';
import { redisConnection } from '../config/redisConnection.js';
import { getIo } from '../config/socket.js';
import logger from '../utils/logger.js';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';
import https from 'https';

// Fix WSL2: força axios a usar IPv4 (evita ENETUNREACH no IPv6)
const ipv4HttpsAgent = new https.Agent({ family: 4 });

// Serviços do pipeline
import { gerarRoteiro } from '../agents/zeus-video.js';
import { gerarVideo } from '../services/video/heygenService.js';
import { gerarVideoIlustrativo } from '../services/video/slideshowService.js';
import { posProducao } from '../services/video/postProduction.js';
import { publicarVideo } from '../services/meta/videoPublisher.js';
import { nomearCampanha, FUNIS } from '../agents/heracles.js';
import Video from '../models/Video.js';
import VeoService, { isVeoConfigured } from '../services/video/veoService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Gera narração TTS em Português Brasileiro
 */
async function gerarNarracaoPTBR(texto, outputPath) {
  logger.info(`[VIDEO WORKER] Gerando narração PT-BR...`);
  
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'nova', // voz feminina, ideal para conteúdo terapêutico
    input: texto,
    speed: 0.95
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  
  logger.info(`[VIDEO WORKER] ✅ Narração PT-BR gerada`);
  return outputPath;
}

const LOGO_PATH = path.join(__dirname, '../assets/logo-overlay.png');

/**
 * Adiciona narração + logo ao vídeo VEO usando FFmpeg
 */
async function mixarNarracaoVeo(videoUrl, audioPath, outputPath) {
  logger.info(`[VIDEO WORKER] Mixando narração ao vídeo VEO...`);

  // Download do vídeo VEO
  const videoResponse = await axios.get(videoUrl, { responseType: 'arraybuffer', httpsAgent: ipv4HttpsAgent });
  const videoPath = outputPath.replace('veo_final_', 'veo_download_');
  fs.writeFileSync(videoPath, Buffer.from(videoResponse.data));

  const hasLogo = fs.existsSync(LOGO_PATH);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath);

    if (hasLogo) {
      cmd.input(LOGO_PATH);
      cmd.complexFilter([
        '[2:v]scale=110:-1[logo]',
        '[0:v][logo]overlay=15:H-h-15[v]'
      ]);
      cmd.outputOptions([
        '-map [v]',
        '-map 1:a',
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a aac',
        '-b:a 128k',
        '-shortest',
        '-movflags +faststart'
      ]);
    } else {
      cmd.outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-b:a 128k',
        '-shortest',
        '-movflags +faststart'
      ]);
    }

    cmd
      .on('end', () => {
        try { fs.unlinkSync(videoPath); } catch (e) {}
        logger.info(`[VIDEO WORKER] ✅ Vídeo VEO com narração${hasLogo ? ' + logo' : ''} pronto`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        try { fs.unlinkSync(videoPath); } catch (e) {}
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * Concatena múltiplos clips Veo com transições xfade (fade entre cenas)
 * @param {string[]} videoUrls - URLs Cloudinary dos clips (já gerados)
 * @param {string} outputPath - Caminho local do arquivo concatenado
 */
async function concatenarClipsVeo(videoUrls, outputPath) {
  const tmpDir = path.dirname(outputPath);
  const ts = Date.now();

  // Download todos os clips em paralelo
  logger.info(`[VIDEO WORKER] Baixando ${videoUrls.length} clips para concatenar...`);
  const clipPaths = await Promise.all(
    videoUrls.map(async (url, i) => {
      const clipPath = path.join(tmpDir, `veo_clip_${ts}_${i}.mp4`);
      const resp = await axios.get(url, { responseType: 'arraybuffer', httpsAgent: ipv4HttpsAgent });
      fs.writeFileSync(clipPath, Buffer.from(resp.data));
      logger.info(`[VIDEO WORKER] Clip ${i + 1}/${videoUrls.length} baixado`);
      return clipPath;
    })
  );

  const CLIP_DURATION = 8;
  const FADE_DURATION = 0.5; // meio segundo de crossfade

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    clipPaths.forEach(p => cmd.input(p));

    // Monta cadeia de filtros xfade
    const filters = [];
    let prevLabel = '[0:v]';
    for (let i = 1; i < clipPaths.length; i++) {
      const offset = i * (CLIP_DURATION - FADE_DURATION);
      const outLabel = i === clipPaths.length - 1 ? '[vout]' : `[v${i}]`;
      filters.push(`${prevLabel}[${i}:v]xfade=transition=fade:duration=${FADE_DURATION}:offset=${offset}${outLabel}`);
      prevLabel = outLabel;
    }

    cmd
      .complexFilter(filters.join(';'))
      .outputOptions([
        '-map [vout]',
        '-an',            // sem áudio (narração adicionada depois)
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-r 24',          // 24fps consistente
        '-movflags +faststart'
      ])
      .on('end', () => {
        clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
        logger.info(`[VIDEO WORKER] ✅ ${clipPaths.length} clips concatenados com xfade`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
        reject(err);
      })
      .save(outputPath);
  });
}

const MUSIC_DIR = path.join(__dirname, '../assets/music');

function getMusicPath(funil) {
  const mapa = { TOPO: 'calma', MEIO: 'esperancosa', FUNDO: 'emocional' };
  const nome = mapa[funil] || 'calma';
  const p = path.join(MUSIC_DIR, `musica_${nome}.mp3`);
  return fs.existsSync(p) ? p : null;
}

/**
 * Adiciona narração TTS + logo + música de fundo a um vídeo local
 */
async function mixarNarracaoLocal(localVideoPath, audioPath, outputPath, funil = 'TOPO') {
  logger.info(`[VIDEO WORKER] Mixando narração ao vídeo concatenado...`);
  const hasLogo   = fs.existsSync(LOGO_PATH);
  const musicPath = getMusicPath(funil);
  const hasMusic  = !!musicPath;

  if (hasMusic) logger.info(`[VIDEO WORKER] 🎵 Adicionando música: ${path.basename(musicPath)}`);

  // Descobrir duração do vídeo para fade-out da música
  const duracao = await new Promise((res, rej) => {
    ffmpeg.ffprobe(localVideoPath, (err, meta) => err ? rej(err) : res(meta.format.duration || 60));
  });

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(localVideoPath)   // [0]: vídeo sem áudio
      .input(audioPath);       // [1]: narração TTS

    if (hasMusic)  cmd.input(musicPath);  // [2]: música
    if (hasLogo)   cmd.input(LOGO_PATH);  // [2] ou [3]: logo

    const filters = [];
    let   vLabel  = '[0:v]';

    // Logo overlay
    if (hasLogo) {
      const logoIdx = hasMusic ? 3 : 2;
      filters.push(
        `[${logoIdx}:v]scale=110:-1[logo]`,
        `${vLabel}[logo]overlay=15:H-h-15[v]`
      );
      vLabel = '[v]';
    }

    // Áudio: narração + música
    let aLabel;
    if (hasMusic) {
      const fadeStart = Math.max(0, duracao - 2);
      filters.push(
        `[1:a]volume=1.0[voz]`,
        `[2:a]volume=0.10,atrim=0:${duracao},afade=t=in:st=0:d=2,afade=t=out:st=${fadeStart}:d=2[bgm]`,
        `[voz][bgm]amix=inputs=2:duration=first[aout]`
      );
      aLabel = '[aout]';
    }

    const mapV = vLabel === '[v]' ? '[v]' : '0:v';
    const mapA = aLabel || '1:a';

    if (filters.length > 0) {
      cmd.complexFilter(filters.join(';'));
    }

    cmd
      .outputOptions([
        `-map ${mapV}`,
        `-map ${mapA}`,
        '-c:v libx264', '-preset fast', '-crf 22',
        '-c:a aac', '-b:a 128k',
        '-shortest',
        '-movflags +faststart'
      ])
      .on('end', () => {
        const extras = [hasLogo && 'logo', hasMusic && 'música'].filter(Boolean).join(' + ');
        logger.info(`[VIDEO WORKER] ✅ Narração${extras ? ' + ' + extras : ''} adicionada ao vídeo final`);
        resolve(outputPath);
      })
      .on('error', reject)
      .save(outputPath);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

const videoWorker = new Worker('video-generation', async (job) => {
  const { 
    jobId, 
    videoDocId,
    tema, 
    especialidadeId, 
    funil = 'TOPO', 
    duracao = 60, 
    publicar = false, 
    targeting = {},
    userId,
    modo = 'avatar',  // 'avatar' (HeyGen), 'ilustrativo' (Slideshow+TTS), 'veo' (Google Veo 3.1)
    tone = 'educativo' // 'emotional', 'educativo', 'inspiracional', 'bastidores'
  } = job.data;

  logger.info(`[VIDEO WORKER] ▶ ${jobId} — "${tema}"`);
  
  // Helper: atualizar progresso no Mongo + Socket.IO
  const atualizarProgresso = async (etapa, percentual, extra = {}) => {
    try {
      await Video.findByIdAndUpdate(videoDocId, {
        pipelineStatus: etapa,
        'progresso.etapa': etapa,
        'progresso.percentual': percentual,
        'progresso.atualizadoEm': new Date(),
        [`tempos.${etapa.toLowerCase().replace('_', '')}Em`]: new Date(),
        ...extra
      });

      // Emitir via Socket.IO
      const io = getIo();
      io.emit(`video-progress-${jobId}`, {
        jobId,
        etapa,
        percentual,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      logger.warn(`[VIDEO WORKER] Erro ao atualizar progresso: ${e.message}`);
    }
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 1: Gerar Roteiro (ZEUS)
    // ═══════════════════════════════════════════════════════════════════════
    await atualizarProgresso('ROTEIRO', 10);
    
    const { roteiro } = await gerarRoteiro({ 
      tema, 
      especialidade: especialidadeId, 
      funil, 
      duracao,
      tone
    });

    await atualizarProgresso('ROTEIRO', 25, {
      roteiro: roteiro.texto_completo,
      roteiroEstruturado: {
        titulo: roteiro.titulo,
        profissional: roteiro.profissional,
        duracaoEstimada: roteiro.duracao_estimada,
        textoCompleto: roteiro.texto_completo,
        hookTextoOverlay: roteiro.hook_texto_overlay,
        ctaTextoOverlay: roteiro.cta_texto_overlay,
        hashtags: roteiro.hashtags,
        copyAnuncio: roteiro.copy_anuncio
      },
      especialidadeId: roteiro.profissional
    });

    logger.info(`[VIDEO WORKER] Roteiro gerado: ${roteiro.profissional} | ${roteiro.titulo}`);

    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 2: Gerar Vídeo (Avatar, Ilustrativo ou Veo 3.1)
    // ═══════════════════════════════════════════════════════════════════════
    await atualizarProgresso('HEYGEN', 30);

    let videoCru;

    if (modo === 'veo') {
      // 🎬 Modo VEO: Google Veo 2.0 — vídeo cinematográfico real
      logger.info(`[VIDEO WORKER] Modo VEO 2.0 - Google AI (cinematográfico)`);

      if (!isVeoConfigured()) {
        throw new Error('GOOGLE_AI_API_KEY não configurado. Acesse aistudio.google.com para obter gratuitamente.');
      }

      // Calcula quantos clips de 8s são necessários para cobrir a duração solicitada
      // Ex: 30s → ceil(30/8) = 4 clips (32s efetivos), 60s → 8 clips (64s efetivos)
      const numClips = Math.max(1, Math.ceil(duracao / 8));
      const duracaoEfetiva = numClips * 8;
      logger.info(`[VIDEO WORKER] Gerando ${numClips} clip(s) Veo de 8s → ${duracaoEfetiva}s de conteúdo (solicitado: ${duracao}s)`);

      // Gera clips sequencialmente para respeitar rate limits da API Veo
      // (geração paralela causa 429 RESOURCE_EXHAUSTED com múltiplos clips)
      const veoService = new VeoService();
      const clipUrls = [];

      for (let i = 0; i < numClips; i++) {
        const progressoGeracao = 30 + Math.round((i / numClips) * 38); // 30% → 68%
        await atualizarProgresso('HEYGEN', progressoGeracao);
        logger.info(`[VIDEO WORKER] Gerando clip ${i + 1}/${numClips}...`);

        let tentativa = 0;
        while (true) {
          try {
            const result = await veoService.gerarVideo(especialidadeId, tema || null, { durationSeconds: 8, aspectRatio: '9:16', clipIndex: i });
            clipUrls.push(result.url);
            logger.info(`[VIDEO WORKER] ✅ Clip ${i + 1}/${numClips} gerado`);
            break;
          } catch (err) {
            const is429 = err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED');
            if (is429 && tentativa < 3) {
              const waitMs = (tentativa + 1) * 30_000; // 30s, 60s, 90s
              logger.warn(`[VIDEO WORKER] ⚠️ Rate limit no clip ${i + 1}, aguardando ${waitMs / 1000}s antes de tentar novamente...`);
              await new Promise(r => setTimeout(r, waitMs));
              tentativa++;
            } else {
              throw err;
            }
          }
        }
      }

      videoCru = clipUrls[0];

      await atualizarProgresso('HEYGEN', 70, {
        videoCruUrl: videoCru,
        videoFinalUrl: videoCru,
        videoUrl: videoCru,
        status: 'processing',
        provider: 'veo-3.1'
      });

      // Preparar diretório temporário
      const tmpDir = path.join(__dirname, '../tmp/videos');
      fs.mkdirSync(tmpDir, { recursive: true });
      const timestamp = Date.now();

      const audioPath    = path.join(tmpDir, `veo_narracao_${timestamp}.mp3`);
      const concatPath   = path.join(tmpDir, `veo_concat_${timestamp}.mp4`);
      const videoFinalPath = path.join(tmpDir, `veo_final_${timestamp}.mp4`);

      // Gerar narração do roteiro
      await atualizarProgresso('POS_PRODUCAO', 73, { etapa: 'GERANDO_NARRACAO' });
      await gerarNarracaoPTBR(roteiro.texto_completo, audioPath);

      // Concatenar clips (ou baixar diretamente se for só 1)
      await atualizarProgresso('POS_PRODUCAO', 80, { etapa: 'CONCATENANDO_CLIPS' });
      if (numClips > 1) {
        logger.info(`[VIDEO WORKER] Concatenando ${numClips} clips com xfade...`);
        await concatenarClipsVeo(clipUrls, concatPath);
      } else {
        // Clip único: download direto
        const videoResponse = await axios.get(clipUrls[0], { responseType: 'arraybuffer', httpsAgent: ipv4HttpsAgent });
        fs.writeFileSync(concatPath, Buffer.from(videoResponse.data));
      }

      // Mixar narração + logo no vídeo concatenado
      await atualizarProgresso('POS_PRODUCAO', 87, { etapa: 'MIXANDO_AUDIO' });
      await mixarNarracaoLocal(concatPath, audioPath, videoFinalPath, funil);
      try { fs.unlinkSync(concatPath); } catch {}

      // Upload para Cloudinary
      await atualizarProgresso('POS_PRODUCAO', 93, { etapa: 'UPLOAD_CLOUDINARY' });
      const cloudinary = (await import('cloudinary')).default;
      const uploadResult = await cloudinary.v2.uploader.upload(videoFinalPath, {
        resource_type: 'video',
        folder: 'fono-inova/ai-videos/veo',
        public_id: `veo_narrado_${timestamp}`,
        overwrite: false
      });
      const videoFinalVeo = uploadResult.secure_url;

      // Limpar temporários
      try { fs.unlinkSync(audioPath); fs.unlinkSync(videoFinalPath); } catch {}

      await atualizarProgresso('POS_PRODUCAO', 95, {
        videoFinalUrl: videoFinalVeo,
        videoUrl: videoFinalVeo
      });

      // Concluir
      await atualizarProgresso('CONCLUIDO', 100, {
        status: 'ready',
        provider: 'veo-3.1',
        'tempos.concluidoEm': new Date()
      });

      const io = getIo();
      io.emit(`video-complete-${jobId}`, {
        jobId,
        status: 'CONCLUIDO',
        videoUrl: videoFinalVeo,
        roteiro: roteiro.titulo,
        provider: 'veo-3.1'
      });

      logger.info(`[VIDEO WORKER] ✅ ${jobId} VEO concluído (${numClips} clip(s) concatenados, ${Math.round((Date.now() - job.timestamp) / 1000)}s total)`);
      return {
        jobId,
        status: 'CONCLUIDO',
        roteiro: { titulo: roteiro.titulo, profissional: roteiro.profissional, duracao: roteiro.duracao_estimada },
        videoFinal: videoFinalVeo,
        provider: 'veo-3.1',
        meta: null
      };

    } else if (modo === 'ilustrativo') {
      logger.info(`[VIDEO WORKER] Modo ILUSTRATIVO - Slideshow de imagens + TTS`);
      videoCru = await gerarVideoIlustrativo({
        especialidadeId,
        roteiro: roteiro.texto_completo,
        titulo: roteiro.titulo,
        duracao
      });
    } else {
      logger.info(`[VIDEO WORKER] Modo AVATAR - Usando HeyGen`);
      videoCru = await gerarVideo({
        profissional: roteiro.profissional,
        textoFala: roteiro.texto_completo,
        titulo: roteiro.titulo
      });
    }

    await atualizarProgresso('HEYGEN', 60, {
      videoCruUrl: videoCru,
      status: 'processing'
    });

    logger.info(`[VIDEO WORKER] Vídeo cru gerado: ${videoCru}`);

    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 3: Pós-Produção (FFmpeg) - Só para avatar
    // ═══════════════════════════════════════════════════════════════════════
    let videoFinal;

    if (modo === 'ilustrativo') {
      // Modo ilustrativo: vídeo já está finalizado (slideshow + narração)
      logger.info(`[VIDEO WORKER] Modo ilustrativo - pulando pós-produção`);
      videoFinal = videoCru;
      await atualizarProgresso('POS_PRODUCAO', 90, {
        videoFinalUrl: videoFinal,
        videoUrl: videoFinal
      });
    } else {
      // Modo avatar: aplicar pós-produção (legendas, logo, etc)
      await atualizarProgresso('POS_PRODUCAO', 65);

      videoFinal = await posProducao({
        videoInput: videoCru,
        hookTexto: roteiro.hook_texto_overlay,
        ctaTexto: roteiro.cta_texto_overlay,
        musica: funil === 'TOPO' ? 'calma' : 'esperancosa',
        titulo: roteiro.titulo
      });

      await atualizarProgresso('POS_PRODUCAO', 90, {
        videoFinalUrl: videoFinal,
        videoUrl: videoFinal  // compatibilidade
      });

      logger.info(`[VIDEO WORKER] Pós-produção concluída: ${videoFinal}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 4: Upload Meta (Opcional)
    // ═══════════════════════════════════════════════════════════════════════
    let metaResult = null;

    if (publicar) {
      await atualizarProgresso('UPLOAD', 92);

      const nomeCampanha = nomearCampanha({
        funil: FUNIS[funil] || funil,
        especialidade: especialidadeId,
        formato: 'REELS'
      });

      try {
        metaResult = await publicarVideo({
          videoPath: videoFinal,
          copy: roteiro.copy_anuncio,
          nomeCampanha,
          targeting
        });

        await atualizarProgresso('UPLOAD', 95, {
          metaCampaignId: metaResult.campaign_id,
          metaCreativeId: metaResult.creative_id,
          metaAdsetId: metaResult.adset_id,
          metaAdId: metaResult.ad_id
        });

        logger.info(`[VIDEO WORKER] Campanha Meta criada: ${metaResult.campaign_id}`);
      } catch (metaErr) {
        logger.error(`[VIDEO WORKER] Erro Meta (não crítico): ${metaErr.message}`);
        // Não falha o job se Meta der erro — vídeo ainda está pronto
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONCLUÍDO
    // ═══════════════════════════════════════════════════════════════════════
    await atualizarProgresso('CONCLUIDO', 100, {
      status: 'ready',
      'tempos.concluidoEm': new Date()
    });

    // Notificar conclusão
    const io = getIo();
    io.emit(`video-complete-${jobId}`, {
      jobId,
      status: 'CONCLUIDO',
      videoUrl: videoFinal,
      roteiro: roteiro.titulo,
      meta: metaResult
    });

    logger.info(`[VIDEO WORKER] ✅ ${jobId} concluído em ${(Date.now() - job.timestamp) / 1000}s`);

    return {
      jobId,
      status: 'CONCLUIDO',
      roteiro: {
        titulo: roteiro.titulo,
        profissional: roteiro.profissional,
        duracao: roteiro.duracao_estimada
      },
      videoFinal,
      meta: metaResult
    };

  } catch (error) {
    const errorMsg = error?.message || error?.toString() || 'Erro desconhecido';
    const errorStack = error?.stack || '';
    logger.error(`[VIDEO WORKER] ❌ ${jobId} falhou: ${errorMsg}`);
    if (errorStack) logger.error(`[VIDEO WORKER] Stack: ${errorStack}`);
    
    // Atualizar como erro
    try {
      await Video.findByIdAndUpdate(videoDocId, {
        status: 'failed',
        pipelineStatus: 'ERRO',
        errorMessage: errorMsg.substring(0, 500),
        'progresso.etapa': 'ERRO',
        'progresso.percentual': 0
      });

      const io = getIo();
      io.emit(`video-progress-${jobId}`, {
        jobId,
        etapa: 'ERRO',
        percentual: 0,
        erro: error.message
      });
    } catch (e) {
      // Ignora erro de atualização
    }

    throw error;
  }
}, {
  connection: redisConnection,
  concurrency: 1,  // 1 vídeo por vez (Veo API: sequential clips per job, avoid double load)
  limiter: {
    max: 10,
    duration: 60000  // 10 jobs por minuto
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────

videoWorker.on('completed', (job, result) => {
  logger.info(`[VIDEO WORKER] ✅ Job ${job.id} finalizado: ${result?.jobId}`);
});

videoWorker.on('failed', (job, err) => {
  logger.error(`[VIDEO WORKER] ❌ Job ${job?.id} falhou: ${err.message}`);
});

videoWorker.on('error', (err) => {
  logger.error('[VIDEO WORKER] Erro no worker:', err.message);
});

logger.info('[VIDEO WORKER] 🎬 Worker inicializado (concurrency: 1)');

export default videoWorker;
