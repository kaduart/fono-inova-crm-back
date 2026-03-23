/**
 * 🎞️ Pós-Produção FFmpeg — Edição automática de vídeo
 * 
 * Operações:
 * - Legendas automáticas (Whisper ou SRT do roteiro)
 * - Logo overlay (canto superior)
 * - Card CTA final (últimos 5s)
 * - Música de fundo (volume baixo)
 * - Formato 9:16, 1080x1920
 * 
 * Usa fluent-ffmpeg (sem exec, sem injeção)
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import logger from '../../utils/logger.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_DIR  = path.resolve(__dirname, '../../assets');
const MUSIC_DIR   = path.resolve(__dirname, '../../assets/music');
const OUTPUT_DIR  = path.resolve(__dirname, '../../tmp/videos/final');

/**
 * Pipeline completo de pós-produção
 * @param {Object} params
 * @param {string} params.videoInput - Caminho do vídeo cru (HeyGen)
 * @param {string} params.hookTexto - Texto do hook (overlay nos primeiros 3s)
 * @param {string} params.ctaTexto - Texto do CTA (padrão: "Fale com a gente no WhatsApp 💚")
 * @param {string} params.musica - 'calma', 'esperancosa' ou 'emocional'
 * @param {string} params.titulo - Título (para nome do arquivo)
 * @returns {string} caminho do vídeo final
 */
export async function posProducao({ 
  videoInput, 
  hookTexto, 
  ctaTexto = 'Fale com a gente no WhatsApp 💚',
  musica = 'calma', 
  titulo 
}) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const timestamp   = Date.now();
  const nomeBase    = (titulo || timestamp).toString().replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const srtPath     = path.join(OUTPUT_DIR, `${timestamp}_legendas.srt`);
  const outputPath  = path.join(OUTPUT_DIR, `${nomeBase}_final.mp4`);

  // ── Etapa 1: Gerar legendas ────────────────────────────────────────────
  logger.info('[POS] 1/4 Gerando legendas...');
  await _gerarLegendasWhisper(videoInput, srtPath);

  // ── Etapa 2: Montar vídeo com FFmpeg ──────────────────────────────────
  logger.info('[POS] 2/4 Montando vídeo final...');
  const duracao = await _getDuracao(videoInput);
  await _montarVideoFFmpeg({ 
    videoInput, 
    srtPath, 
    hookTexto, 
    ctaTexto,
    musica, 
    duracao, 
    outputPath 
  });

  // ── Etapa 3: Validar output ───────────────────────────────────────────
  logger.info('[POS] 3/4 Validando...');
  const stats = fs.statSync(outputPath);
  const duracaoFinal = await _getDuracao(outputPath);

  if (duracaoFinal < 5 || stats.size < 500_000) {
    throw new Error(`Vídeo inválido: ${duracaoFinal}s | ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
  }

  // ── Etapa 4: Limpar temporários ───────────────────────────────────────
  logger.info('[POS] 4/4 Limpando temporários...');
  try { 
    if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath); 
  } catch (_) { /* não crítico */ }

  logger.info(`[POS] ✅ ${outputPath} — ${duracaoFinal.toFixed(1)}s | ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
  return outputPath;
}

/**
 * Montagem via fluent-ffmpeg (sem exec, sem injeção)
 */
function _montarVideoFFmpeg({ videoInput, srtPath, hookTexto, ctaTexto, musica, duracao, outputPath }) {
  const logoPath   = path.join(ASSETS_DIR, 'logo-overlay.png');
  const ctaPath    = path.join(ASSETS_DIR, 'cta_card.png');  // opcional, não obrigatório
  const musicaPath = path.join(MUSIC_DIR, `musica_${musica}.mp3`);
  
  // Fonte Roboto (padrão Ubuntu/Debian)
  const fontPath = '/usr/share/fonts/truetype/roboto/Roboto-Bold.ttf';
  const fontFallback = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontFinal = fs.existsSync(fontPath) ? fontPath : fontFallback;

  // CTA aparece nos últimos 5s
  const ctaInicio = Math.max(0, duracao - 5);

  // Sanitizar texto do hook (evita quebra no drawtext)
  const hookSafe = (hookTexto || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  '\u2019')   // apóstrofo tipográfico
    .replace(/:/g,  '\\:')      // escapar dois pontos
    .replace(/\n/g, ' ')
    .substring(0, 100);         // limite de segurança

  // Sanitizar caminho SRT
  const srtSafe = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  // Verificar se assets existem
  if (!fs.existsSync(logoPath)) {
    logger.warn(`[POS] Logo não encontrado: ${logoPath}`);
  }
  if (!fs.existsSync(ctaPath)) {
    logger.warn(`[POS] CTA card não encontrado: ${ctaPath}`);
  }
  if (!fs.existsSync(musicaPath)) {
    logger.warn(`[POS] Música não encontrada: ${musicaPath}`);
  }

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();

    // Inputs com rastreamento dinâmico de índices
    cmd = cmd.input(videoInput);  // sempre [0]
    let nextIdx = 1;
    let logoIdx = -1, ctaIdx = -1, musicaIdx = -1;

    if (fs.existsSync(logoPath)) {
      cmd = cmd.input(logoPath);
      logoIdx = nextIdx++;
    }
    if (fs.existsSync(ctaPath)) {
      cmd = cmd.input(ctaPath);
      ctaIdx = nextIdx++;
    }
    if (fs.existsSync(musicaPath)) {
      cmd = cmd.input(musicaPath);
      musicaIdx = nextIdx++;
    }

    // Construir filter_complex
    const filters = [];

    // 1. Hook overlay (primeiros 3.5s)
    if (hookSafe) {
      filters.push(
        `[0:v]drawtext=text='${hookSafe}':fontfile='${fontFinal}':fontsize=42:` +
        `fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.15:` +
        `enable='between(t,0,3.5)'[hook]`
      );
    } else {
      filters.push('[0:v]copy[hook]');
    }

    // 2. Legendas SRT (só usa se o arquivo existe e tem conteúdo)
    const srtValido = fs.existsSync(srtPath) && fs.statSync(srtPath).size > 0;
    if (srtValido) {
      filters.push(
        `[hook]subtitles='${srtSafe}':force_style='FontName=Roboto,FontSize=28,` +
        `PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Bold=1,` +
        `Alignment=2,MarginV=180'[subs]`
      );
    } else {
      filters.push('[hook]copy[subs]');
    }

    // 3. Logo overlay (índice dinâmico)
    if (logoIdx !== -1) {
      filters.push(
        `[${logoIdx}:v]scale=120:-1[logo]`,
        `[subs][logo]overlay=W-w-30:30:enable='between(t,0,${ctaInicio})'[withlogo]`
      );
    } else {
      filters.push('[subs]copy[withlogo]');
    }

    // 4. Card CTA (índice dinâmico)
    if (ctaIdx !== -1) {
      filters.push(
        `[${ctaIdx}:v]scale=1080:1920[cta]`,
        `[withlogo][cta]overlay=0:0:enable='gte(t,${ctaInicio})'[vout]`
      );
    } else {
      filters.push('[withlogo]copy[vout]');
    }

    // 5. Áudio: voz + música (índice dinâmico)
    if (musicaIdx !== -1) {
      filters.push(
        `[0:a]volume=1.0[voz]`,
        `[${musicaIdx}:a]volume=0.08,atrim=0:${duracao},afade=t=in:st=0:d=2,` +
        `afade=t=out:st=${duracao - 2}:d=2[bgm]`,
        `[voz][bgm]amix=inputs=2:duration=first[aout]`
      );
    } else {
      filters.push('[0:a]copy[aout]');
    }

    const filterComplex = filters.join(';');

    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        '-map [vout]',
        '-map [aout]',
        '-c:v libx264',
        '-preset fast',      // equilíbrio velocidade/qualidade
        '-crf 23',           // qualidade boa, tamanho ok
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',  // otimiza pra streaming
        `-t ${duracao}`
      ])
      .on('start', (commandLine) => {
        logger.debug(`[FFMPEG] Comando: ${commandLine}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          logger.debug(`[FFMPEG] ${progress.percent.toFixed(0)}%`);
        }
      })
      .on('end', () => {
        logger.info('[FFMPEG] ✅ Processamento concluído');
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        logger.error(`[FFMPEG] Erro: ${stderr}`);
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * Gera legendas com Whisper (local) ou fallback vazio
 */
async function _gerarLegendasWhisper(videoPath, srtOutput) {
  const outputDir = path.dirname(srtOutput);
  const baseName  = path.basename(videoPath, '.mp4');
  const whisperGerado = path.join(outputDir, `${baseName}.srt`);

  return new Promise((resolve) => {
    // Tentar Whisper local
    const cmd = `whisper "${videoPath}" --model small --language pt --output_format srt --output_dir "${outputDir}"`;

    exec(cmd, { timeout: 300000 }, (error) => {  // 5 min timeout
      if (error || !fs.existsSync(whisperGerado)) {
        logger.warn('[WHISPER] Falha ou não instalado — usando SRT vazio');
        fs.writeFileSync(srtOutput, '');
        return resolve();
      }

      // Renomear se necessário
      if (whisperGerado !== srtOutput && fs.existsSync(whisperGerado)) {
        fs.renameSync(whisperGerado, srtOutput);
      }
      
      logger.info('[WHISPER] ✅ Legendas geradas');
      resolve();
    });
  });
}

/**
 * Gera SRT a partir do roteiro (quando Whisper não disponível)
 * Usado como fallback ou quando precisa de sincronização perfeita
 */
export function gerarSRTdoRoteiro(textoCompleto, duracaoTotal) {
  const palavras = textoCompleto.split(/\s+/).filter(Boolean);
  const palavrasPorSegundo = palavras.length / duracaoTotal;
  const palavrasPorBloco = Math.ceil(palavrasPorSegundo * 3); // blocos de ~3s

  let srt = '';
  let bloco = 1;
  let i = 0;

  while (i < palavras.length) {
    const inicio = i / palavrasPorSegundo;
    const fim = Math.min(inicio + 3, duracaoTotal);
    const textoBloco = palavras.slice(i, i + palavrasPorBloco).join(' ');

    srt += `${bloco}\n${_formatSRTTime(inicio)} --> ${_formatSRTTime(fim)}\n${textoBloco}\n\n`;

    bloco++;
    i += palavrasPorBloco;
  }

  return srt;
}

/**
 * Obtém duração do vídeo em segundos
 */
function _getDuracao(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

function _formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${_pad(h)}:${_pad(m)}:${_pad(s)},${_pad(ms, 3)}`;
}

function _pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

export default { posProducao, gerarSRTdoRoteiro };
