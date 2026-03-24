/**
 * 🎬 Pós-Produção para Vídeos Veo
 *
 * Pipeline:
 * 1. Download vídeo bruto do Cloudinary
 * 2. Transcrição OpenAI Whisper → timestamps por palavra
 * 3. Gera arquivo ASS (Reels style) com legendas animadas
 * 4. FFmpeg: queima legendas + música de fundo + CTA overlay
 * 5. Upload resultado ao Cloudinary
 * 6. Atualiza documento Video no MongoDB
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import https from 'https';
import axios from 'axios';
import { fileURLToPath } from 'url';
import FormData from 'form-data';
import { v2 as cloudinary } from 'cloudinary';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const TMP_DIR    = path.resolve(__dirname, '../../tmp/pos_producao');
const ASSETS_DIR = path.resolve(__dirname, '../../assets/video');
const MUSIC_DIR  = path.resolve(__dirname, '../../assets/music');

const ipv4Agent = new https.Agent({ family: 4 });

/**
 * Ponto de entrada principal
 * @param {Object} params
 * @param {string} params.videoId        - ID do documento Video
 * @param {string} params.videoUrl       - URL Cloudinary do vídeo bruto
 * @param {string} params.roteiro        - Texto do roteiro (fallback Whisper)
 * @param {boolean} params.legendas      - Ativar legendas queimadas
 * @param {string|null} params.musica    - 'calma'|'esperancosa'|'emocional'|null
 * @param {number} params.musicVolume    - Volume da música de fundo (0.0–1.0, padrão 0.20)
 * @param {Object|null} params.cta       - { texto, subtexto, cor }
 * @param {Object|null} params.logo      - { usarPadrao: bool } | { url: string } | null
 * @param {string} params.logoPosition   - 'top-left'|'top-right'|'bottom-left'|'bottom-right'
 * @param {string|null} params.watermarkText - Texto fixo sobre o vídeo (ex: @clinica)
 * @param {number} params.trimStart      - Segundos a cortar do início
 * @param {number} params.trimEnd        - Segundos a cortar do final
 * @returns {string} URL Cloudinary do vídeo editado
 */
export async function aplicarPosProducao({
  videoId, videoUrl, roteiro,
  legendas = true, musica = null, musicVolume = 0.05, cta = null,
  logo = null, logoPosition = 'bottom-right',
  watermarkText = null,
  trimStart = 0, trimEnd = 0,
  subtitleFontSize = 88, subtitleFontColor = '&H0000FFFF'
}) {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const ts        = Date.now();
  const rawPath   = path.join(TMP_DIR, `raw_${ts}.mp4`);
  const assPath   = path.join(TMP_DIR, `subs_${ts}.ass`);
  const outPath   = path.join(TMP_DIR, `edited_${ts}.mp4`);
  const trimPath  = path.join(TMP_DIR, `trimmed_${ts}.mp4`);
  const logoTmp   = path.join(TMP_DIR, `logo_${ts}.png`);

  const tempFiles = [rawPath, assPath, outPath, trimPath, logoTmp];

  try {
    // ── 1. Download vídeo bruto ─────────────────────────────────────────
    logger.info(`[POS-VEO] 1/6 Baixando vídeo: ${videoUrl}`);
    await _downloadVideo(videoUrl, rawPath);

    let inputPath = rawPath;
    let duracao = await _getDuracao(rawPath);
    logger.info(`[POS-VEO] Duração original: ${duracao.toFixed(1)}s`);

    // ── 2. Trim (se solicitado) ────────────────────────────────────────
    const trimStartSafe = Math.max(0, Number(trimStart) || 0);
    const trimEndSafe   = Math.max(0, Number(trimEnd) || 0);
    if (trimStartSafe > 0 || trimEndSafe > 0) {
      const novaDuracao = duracao - trimStartSafe - trimEndSafe;
      if (novaDuracao < 2) throw new Error('Trim inválido: vídeo resultante seria menor que 2 segundos');
      logger.info(`[POS-VEO] 2/6 Trim: início=${trimStartSafe}s fim=${trimEndSafe}s → ${novaDuracao.toFixed(1)}s`);
      await _trimVideo(rawPath, trimPath, trimStartSafe, novaDuracao);
      inputPath = trimPath;
      duracao = await _getDuracao(trimPath);
    } else {
      logger.info('[POS-VEO] 2/6 Sem trim');
    }

    // ── 3. Transcrição Whisper → ASS ─────────────────────────────────────
    if (legendas) {
      logger.info('[POS-VEO] 3/6 Gerando legendas...');
      const transcript = await _transcreverWhisper(inputPath, roteiro, duracao);
      _gerarASS(transcript, assPath, duracao, subtitleFontSize, subtitleFontColor);
    } else {
      logger.info('[POS-VEO] 3/6 Legendas desativadas');
    }

    // ── 4. Resolver logo ──────────────────────────────────────────────────
    let logoPath = null;
    if (logo) {
      if (logo.usarPadrao) {
        const candidatos = [
          path.join(ASSETS_DIR, 'logo-overlay.png'),
          path.join(__dirname, '../../assets/logo-overlay.png'),
          path.join(__dirname, '../../../front/public/images/logo-unica.png')
        ];
        logoPath = candidatos.find(p => fs.existsSync(p)) || null;
        if (logoPath) logger.info(`[POS-VEO] 4/6 Logo padrão: ${logoPath}`);
        else logger.warn('[POS-VEO] 4/6 Logo padrão não encontrado — ignorando');
      } else if (logo.url) {
        logger.info(`[POS-VEO] 4/6 Baixando logo: ${logo.url}`);
        await _downloadVideo(logo.url, logoTmp);
        logoPath = logoTmp;
      }
    } else {
      logger.info('[POS-VEO] 4/6 Sem logo');
    }

    // ── 5. Montar vídeo editado ───────────────────────────────────────────
    logger.info('[POS-VEO] 5/6 Aplicando edições FFmpeg...');
    await _montarFFmpeg({
      inputPath,
      assPath: legendas ? assPath : null,
      musica, musicVolume,
      cta, duracao, outPath,
      logoPath, logoPosition,
      watermarkText
    });

    // ── 6. Validar + Upload ───────────────────────────────────────────────
    logger.info('[POS-VEO] 6/6 Validando e enviando ao Cloudinary...');
    const stats = fs.statSync(outPath);
    const duracaoFinal = await _getDuracao(outPath);
    logger.info(`[POS-VEO] ✅ Vídeo gerado: ${duracaoFinal.toFixed(1)}s / ${(stats.size / 1024 / 1024).toFixed(1)}MB`);

    if (duracaoFinal < 2 || stats.size < 100_000) {
      throw new Error(`Vídeo editado inválido: ${duracaoFinal.toFixed(1)}s / ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
    }

    const cloudUrl = await _uploadCloudinary(outPath, videoId);
    logger.info(`[POS-VEO] ✅ Pronto: ${cloudUrl}`);
    return cloudUrl;

  } finally {
    for (const p of tempFiles) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ok */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Trim
// ─────────────────────────────────────────────────────────────────────────────

async function _trimVideo(inputPath, outputPath, start, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputOptions([`-ss ${start}`])
      .outputOptions([`-t ${duration}`, '-c copy'])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

async function _downloadVideo(url, dest) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    httpsAgent: ipv4Agent,
    timeout: 120_000
  });
  fs.writeFileSync(dest, Buffer.from(resp.data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcrição Whisper (API OpenAI) → array de segments { start, end, text }
// ─────────────────────────────────────────────────────────────────────────────

async function _transcreverWhisper(videoPath, roteiro, duracao) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (apiKey) {
    try {
      logger.info('[WHISPER] Enviando para OpenAI Whisper API...');

      // Extrair áudio em MP3 temporário para menor payload
      const audioPath = videoPath.replace('.mp4', '_audio.mp3');
      await _extrairAudio(videoPath, audioPath);

      const form = new FormData();
      form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
      form.append('model', 'whisper-1');
      form.append('language', 'pt');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');

      const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
        httpsAgent: ipv4Agent,
        timeout: 120_000,
        maxBodyLength: Infinity
      });

      try { fs.unlinkSync(audioPath); } catch (_) { /* ok */ }

      const segments = (resp.data.segments || []).map(s => ({
        start: s.start,
        end:   s.end,
        text:  s.text.trim()
      }));

      if (segments.length > 0) {
        logger.info(`[WHISPER] ✅ ${segments.length} segmentos`);
        return segments;
      }
    } catch (err) {
      logger.warn(`[WHISPER] Falha API: ${err.message} — usando fallback roteiro`);
    }
  }

  // Fallback: dividir roteiro em segmentos de ~4 palavras
  return _segmentarRoteiro(roteiro, duracao);
}

async function _extrairAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions(['-vn', '-ar 16000', '-ac 1', '-b:a 64k'])
      .save(audioPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

function _segmentarRoteiro(roteiro, duracao) {
  const palavras = (roteiro || '').split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return [];

  const segsDesejados = Math.ceil(duracao / 4); // ~4s por segmento
  const palavrasPorSeg = Math.max(1, Math.ceil(palavras.length / segsDesejados));
  const segments = [];

  for (let i = 0; i < palavras.length; i += palavrasPorSeg) {
    const segIdx = Math.floor(i / palavrasPorSeg);
    const start  = segIdx * (duracao / segsDesejados);
    const end    = Math.min((segIdx + 1) * (duracao / segsDesejados), duracao);
    segments.push({ start, end, text: palavras.slice(i, i + palavrasPorSeg).join(' ') });
  }
  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gerar arquivo ASS (Reels style: texto branco bold centralizado em baixo)
// ─────────────────────────────────────────────────────────────────────────────

function _gerarASS(segments, assPath, duracao, fontSize = 88, fontColor = '&H0000FFFF') {
  logger.info(`[ASS] Gerando arquivo: ${assPath} com ${segments.length} segmentos (fontSize=${fontSize})`);

  // Estilo TikTok/Reels moderno: texto grande, bold centralizado
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok,Roboto Black,${fontSize},${fontColor},&H0000FFFF,&H00000000,&H99000000,-1,0,0,0,105,105,0,0,1,6,3,2,60,60,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const lines = segments.map(seg => {
    const start = _formatASSTime(seg.start);
    const end   = _formatASSTime(Math.min(seg.end, duracao));
    const text  = _sanitizeASSText(seg.text);
    return `Dialogue: 0,${start},${end},TikTok,,0,0,0,,${text}`;
  });

  const content = header + lines.join('\n');
  fs.writeFileSync(assPath, content);
  
  logger.info(`[ASS] ✅ Arquivo criado: ${assPath} (${content.length} bytes)`);
}

function _formatASSTime(s) {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const cs = Math.round((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function _sanitizeASSText(text) {
  return text
    .replace(/\{/g, '')
    .replace(/\}/g, '')
    .replace(/\n/g, '\\N')
    .substring(0, 120);
}

// ─────────────────────────────────────────────────────────────────────────────
// Montagem FFmpeg
// ─────────────────────────────────────────────────────────────────────────────

function _montarFFmpeg({ inputPath, assPath, musica, musicVolume = 0.05, cta, duracao, outPath, logoPath = null, logoPosition = 'bottom-right', watermarkText = null }) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg().input(inputPath);  // [0]: vídeo bruto

    const musicaPath = musica ? path.join(MUSIC_DIR, `musica_${musica}.mp3`) : null;
    const temMusica  = musicaPath && fs.existsSync(musicaPath);
    const temLogo    = logoPath && fs.existsSync(logoPath);

    // Rastrear índice dos inputs extras
    let nextInput = 1;
    let musicaInputIdx = -1;
    let logoInputIdx   = -1;

    if (temMusica) {
      cmd = cmd.input(musicaPath);
      musicaInputIdx = nextInput++;
      logger.info(`[FFMPEG-POS] ✅ Música [${musicaInputIdx}]: ${musicaPath}`);
    } else if (musica) {
      logger.warn(`[FFMPEG-POS] ⚠️ Música '${musica}' não encontrada`);
    }

    if (temLogo) {
      cmd = cmd.input(logoPath);
      logoInputIdx = nextInput++;
      logger.info(`[FFMPEG-POS] ✅ Logo [${logoInputIdx}]: ${logoPath} pos=${logoPosition}`);
    }

    const filters    = [];
    let   videoLabel = '[0:v]';

    // ── Legendas ASS ──────────────────────────────────────────────────────
    if (assPath && fs.existsSync(assPath)) {
      const assSafe = assPath.replace(/\\/g, '/').replace(/'/g, "\\'");
      logger.info(`[FFMPEG-POS] ✅ ASS: ${assSafe}`);
      filters.push(`${videoLabel}ass='${assSafe}'[vsubs]`);
      videoLabel = '[vsubs]';
    }

    // ── Logo overlay ──────────────────────────────────────────────────────
    if (temLogo) {
      const pos = _logoOverlayPos(logoPosition);
      filters.push(`[${logoInputIdx}:v]scale=120:-1[logo_scaled]`);
      filters.push(`${videoLabel}[logo_scaled]overlay=${pos}[vlogo]`);
      videoLabel = '[vlogo]';
    }

    // ── Watermark texto fixo ──────────────────────────────────────────────
    if (watermarkText) {
      const wmSafe = _sanitizaDrawtext(watermarkText);
      filters.push(
        `${videoLabel}drawtext=text='${wmSafe}':fontsize=28:fontcolor=white@0.55:` +
        `x=20:y=20:shadowx=1:shadowy=1:shadowcolor=0x00000099[vwm]`
      );
      videoLabel = '[vwm]';
    }

    // ── CTA overlay (primeiros 5s + últimos 5s) ───────────────────────────
    if (cta?.texto) {
      const ctaFim1    = Math.min(5, duracao);
      const ctaInicio2 = Math.max(0, duracao - 5);
      const corHex     = _hexToFFmpeg(cta.cor || '#ef4444');
      const textSafe   = _sanitizaDrawtext(cta.texto);
      const subSafe    = cta.subtexto ? _sanitizaDrawtext(cta.subtexto) : null;
      const enableExpr = `between(t,0,${ctaFim1})+gte(t,${ctaInicio2})`;

      const ctaWidth  = 260;
      const ctaHeight = subSafe ? 50 : 32;
      const ctaX      = 230;
      filters.push(
        `${videoLabel}drawbox=x=${ctaX}:y=ih-${ctaHeight+8}:w=${ctaWidth}:h=${ctaHeight}:color=${corHex}@0.80:t=fill:enable='${enableExpr}'[vcta_bg]`
      );
      videoLabel = '[vcta_bg]';
      filters.push(
        `${videoLabel}drawtext=text='${textSafe}':fontsize=20:fontcolor=white:x=${ctaX+10}:y=h-${ctaHeight+6}:borderw=1:bordercolor=0x00000060:shadowx=1:shadowy=1:shadowcolor=0x00000080:enable='${enableExpr}'[vcta_txt]`
      );
      videoLabel = '[vcta_txt]';
      if (subSafe) {
        filters.push(
          `${videoLabel}drawtext=text='${subSafe}':fontsize=14:fontcolor=white@0.85:x=${ctaX+10}:y=h-26:borderw=1:bordercolor=0x00000040:enable='${enableExpr}'[vcta_sub]`
        );
        videoLabel = '[vcta_sub]';
      }
    }

    // Renomear label de vídeo final
    if (videoLabel !== '[vout]') {
      filters.push(`${videoLabel}copy[vout]`);
    }

    // ── Áudio ─────────────────────────────────────────────────────────────
    let mapA = '0:a:0';
    if (temMusica) {
      let vol = Number(musicVolume);
      if (isNaN(vol) || vol < 0) vol = 0.05;
      if (vol > 1.0) vol = 1.0;

      logger.info(`[FFMPEG-POS] 🎵 Volume da música: ${vol} (recebido: ${musicVolume})`);

      const fadeStart = Math.max(0, duracao - 2);
      filters.push(
        `[0:a]volume=1.0[voz]`,
        `[${musicaInputIdx}:a]volume=${vol},atrim=0:${duracao},afade=t=in:st=0:d=2,afade=t=out:st=${fadeStart}:d=2[bgm]`,
        `[voz][bgm]amix=inputs=2:duration=first:normalize=0[aout]`
      );
      mapA = '[aout]';
    }

    const filterString = filters.join(';');
    logger.info(`[FFMPEG-POS] Filter complex (${filters.length} filtros): ${filterString.substring(0, 300)}...`);

    cmd
      .complexFilter(filterString)
      .outputOptions([
        '-map [vout]',
        `-map ${mapA}`,
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        `-t ${duracao}`
      ])
      .on('start', cl => logger.info(`[FFMPEG-POS] Command: ${cl.substring(0, 200)}...`))
      .on('error', (err, _stdout, stderr) => {
        logger.error(`[FFMPEG-POS] Erro: ${stderr}`);
        reject(err);
      })
      .on('end', resolve)
      .save(outPath);
  });
}

function _logoOverlayPos(position) {
  switch (position) {
    case 'top-left':     return 'x=15:y=15';
    case 'top-right':    return 'x=W-w-15:y=15';
    case 'bottom-left':  return 'x=15:y=H-h-15';
    case 'bottom-right': return 'x=W-w-15:y=H-h-15';
    case 'center':       return 'x=(W-w)/2:y=(H-h)/2';
    default:             return 'x=W-w-15:y=H-h-15';
  }
}

function _sanitizaDrawtext(text) {
  return (text || '')
    // Remove emojis e caracteres fora do BMP (causam erro no drawtext)
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u2600-\u27BF]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  '\u2019')
    .replace(/:/g,  '\\:')
    .replace(/\n/g, ' ')
    .trim()
    .substring(0, 80);
}

function _hexToFFmpeg(hex) {
  // #ef4444 → 0xef4444
  return hex.replace('#', '0x');
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload Cloudinary
// ─────────────────────────────────────────────────────────────────────────────

async function _uploadCloudinary(filePath, videoId) {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'video',
    folder: 'clinica/videos/editados',
    public_id: `video_edit_${videoId}_${Date.now()}`,
    overwrite: true,
    transformation: [{ quality: 'auto' }]
  });
  return result.secure_url;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────

function _getDuracao(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) reject(err);
      else resolve(meta.format.duration || 0);
    });
  });
}
