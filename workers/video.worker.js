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
import { postGenerationQueue } from '../config/bullConfig.js';
import { gerarVideo } from '../services/video/heygenService.js';
import { gerarVideoIlustrativo } from '../services/video/slideshowService.js';
import { posProducao, gerarSRTdoRoteiro } from '../services/video/postProduction.js';
import { publicarVideo } from '../services/meta/videoPublisher.js';
import { nomearCampanha, FUNIS } from '../agents/heracles.js';
import Video from '../models/Video.js';
import InstagramPost from '../models/InstagramPost.js';
import VeoService, { isVeoConfigured } from '../services/video/veoService.js';
import RunwayService, { isRunwayConfigured, CLIP_DURATION as RUNWAY_CLIP_DURATION } from '../services/video/runwayService.js';
import { getFullProductionConfig, recommendPreset, getTTSConfig, getMusicConfig, getVEOConfig, listPresets } from '../services/video/presetService.js';
import { aplicarPosProducao } from '../services/video/posProducaoVeoService.js';
import { posProducaoQueue } from '../config/bullConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Gera narração TTS em Português Brasileiro
 * @param {string} texto - Texto para narração
 * @param {string} outputPath - Caminho de saída
 * @param {Object} options - Opções de narração
 * @param {string} options.tone - 'emotional' | 'inspiracional' | 'educativo' | 'bastidores'
 * @param {string} options.intensidade - 'leve' | 'moderado' | 'forte' | 'viral'
 * @param {string} options.voice - 'nova' | 'shimmer' | 'alloy' | 'echo' | 'fable' | 'onyx' (do preset)
 * @param {number} options.speed - Velocidade da fala (0.5-2.0)
 */
async function gerarNarracaoPTBR(texto, outputPath, options = {}) {
  const { tone = 'educativo', intensidade = 'moderado', voice: presetVoice, speed: presetSpeed } = options;
  
  // 🎙️ Configuração dinâmica baseada no tom e intensidade (ou preset)
  let voice = presetVoice || 'nova';      // padrão: suave, terapêutica
  let speed = presetSpeed || 1.0;         // padrão: velocidade normal
  
  // Se não veio de preset, aplicar lógica automática
  if (!presetVoice) {
    if (intensidade === 'viral' || intensidade === 'forte') {
      voice = tone === 'emotional' ? 'shimmer' : 'alloy';
    } else if (tone === 'emotional' || tone === 'inspiracional') {
      voice = 'shimmer';
    } else if (tone === 'bastidores') {
      voice = 'alloy';
    }
  }
  
  // Calcular número de palavras para log e ajustes
  const palavras = texto.split(/\s+/).length;
  
  if (!presetSpeed) {
    if (intensidade === 'viral' || intensidade === 'forte') {
      speed = 1.05;
    } else if (tone === 'bastidores') {
      speed = 1.02;
    }
    
    // Ajuste fino: vídeos curtos (Instagram) = mais dinâmicos
    if (palavras < 50 && intensidade !== 'leve') {
      speed = Math.min(speed + 0.02, 1.08);
    }
  }
  
  logger.info(`[VIDEO WORKER] Gerando narração PT-BR: voz=${voice}, speed=${speed}, tone=${tone}`);
  
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice,
    input: texto,
    speed
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  
  logger.info(`[VIDEO WORKER] ✅ Narração PT-BR gerada (${palavras} palavras, ${Math.round(palavras / (speed * 2.2))}s estimados)`);
  return outputPath;
}

/**
 * 🎙️ Configurações de TTS específicas por estágio Zeus v3.2
 * Garante alinhamento emocional: roteiro acolhedor = voz acolhedora
 */
function getTTSPorEstagioZeus(estagioJornada) {
  const configs = {
    descoberta: {
      // Tom acolhedor, calmo, quase sussurrado - SEM tensão
      voice: 'nova',        // Voz suave, terapêutica
      speed: 0.95,          // LENTO - respiração entre frases
      tom: 'acolhedor_calmo',
      pausas: 'longas',     // Pausas emocionais importantes
      instrucao: 'Falar como numa conversa íntima. Voz suave, calma. Pausar após frases emocionais. NÃO soar como advertência.'
    },
    consideracao: {
      // Autoridade gentil - confiança sem pressão
      voice: 'alloy',       // Voz neutra-profissional
      speed: 1.0,           // Ritmo natural
      tom: 'autoridade_empatica',
      pausas: 'claras',
      instrucao: 'Tom de especialista confiável. Firme mas gentil. Demonstrar competência sem arrogância.'
    },
    decisao: {
      // Direto mas humano - remover objeções
      voice: 'echo',        // Voz mais grave, direta
      speed: 1.02,          // Levemente mais rápido (ação)
      tom: 'direto_desbloqueador',
      pausas: 'impactantes',
      instrucao: 'Falar a verdade sem rodeios. Tom firme mas não agressivo. Como um amigo especialista.'
    },
    retargeting: {
      // Cumplicidade - remoção de culpa
      voice: 'nova',        // Volta à suavidade
      speed: 0.98,          // Tranquilo
      tom: 'cumplicidade_tranquila',
      pausas: 'confortaveis',
      instrucao: 'Tom de continuidade, sem julgamento. Tranquilidade. "Já sabia disso - vamos em frente."'
    }
  };
  
  return configs[estagioJornada] || configs.descoberta;
}

const LOGO_PATH       = path.join(__dirname, '../assets/logo-overlay.png');
const CTA_PATH        = path.join(__dirname, '../assets/cta_card.png');
const LOGO_UNICA_PATH = path.join(__dirname, '../../front/public/images/logo-unica.png');
const OUTRO_SFX_PATH  = path.join(__dirname, '../assets/outro-sfx.mp3'); // whoosh/ding de transição para o outro
const FONT_PATH = fs.existsSync('/usr/share/fonts/truetype/roboto/Roboto-Bold.ttf')
  ? '/usr/share/fonts/truetype/roboto/Roboto-Bold.ttf'
  : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

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
        '[0:v][logo]overlay=W-w-15:H-h-15[v]'
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
        try {
          try { fs.unlinkSync(videoPath); } catch (e) {}
          logger.info(`[VIDEO WORKER] ✅ Vídeo VEO com narração${hasLogo ? ' + logo' : ''} pronto`);
          resolve(outputPath);
        } catch (cbErr) {
          reject(cbErr);
        }
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
        try {
          clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
          logger.info(`[VIDEO WORKER] ✅ ${clipPaths.length} clips concatenados com xfade`);
          resolve(outputPath);
        } catch (cbErr) {
          reject(cbErr);
        }
      })
      .on('error', (err) => {
        clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });
        reject(err);
      })
      .save(outputPath);
  });
}

const MUSIC_DIR = path.join(__dirname, '../assets/music');

// ─────────────────────────────────────────────────────────────────────────────
// MODO ECONÔMICO — Slideshow Ken Burns + TTS + pós-produção premium
// ─────────────────────────────────────────────────────────────────────────────

const PEXELS_KEYWORDS_ECO = {
  fonoaudiologia:     ['speech therapy children colorful', 'kids language development games', 'child speech exercises'],
  psicologia:         ['child psychology therapy caring', 'children mental health support', 'kids counseling safe space'],
  terapia_ocupacional:['children occupational therapy sensory', 'kids therapy toys educational', 'child development activities'],
  fisioterapia:       ['pediatric physiotherapy exercises fun', 'children physical therapy', 'kids rehabilitation playing'],
  psicomotricidade:   ['children movement activities', 'kids motor skills play', 'child physical development'],
  musicoterapia:      ['music therapy children instruments', 'kids playing music therapy', 'children musical activities'],
  neuropsicologia:    ['child neurological therapy', 'kids cognitive development', 'children brain therapy'],
  psicopedagogia:     ['children learning support education', 'kids study help teacher', 'child reading learning'],
  freio_lingual:      ['speech therapy children smiling', 'oral health children dentist', 'kids mouth therapy'],
};

async function buscarImagensEco(especialidade, count, tmpDir, baseName) {
  const imagens = [];
  const apiKey = process.env.PEXELS_API_KEY;

  if (apiKey && apiKey !== 'sua_chave_aqui') {
    try {
      const keywords = PEXELS_KEYWORDS_ECO[especialidade] || ['children therapy clinic colorful', 'kids healthcare professional', 'child development activities'];
      const keyword  = keywords[Math.floor(Math.random() * keywords.length)];

      const resp = await axios.get('https://api.pexels.com/v1/search', {
        headers: { Authorization: apiKey },
        params:  { query: keyword, orientation: 'portrait', per_page: count + 5 }
      });

      const photos = resp.data.photos || [];
      for (let i = 0; i < Math.min(count, photos.length); i++) {
        const url     = photos[i].src.portrait || photos[i].src.medium;
        const imgPath = path.join(tmpDir, `${baseName}_img_${i}.jpg`);
        const img     = await axios.get(url, { responseType: 'arraybuffer' });
        fs.writeFileSync(imgPath, Buffer.from(img.data));
        imagens.push(imgPath);
      }
      logger.info(`[ECO] ${imagens.length} imagens baixadas do Pexels (${keyword})`);
    } catch (e) {
      logger.warn(`[ECO] Erro Pexels: ${e.message}`);
    }
  }

  // Fallback: frames coloridos via FFmpeg
  if (imagens.length === 0) {
    const cores = ['#1a5276', '#1e8449', '#7b241c', '#6c3483', '#117a65', '#935116'];
    for (let i = 0; i < count; i++) {
      const imgPath = path.join(tmpDir, `${baseName}_img_${i}.jpg`);
      await new Promise((res, rej) => {
        ffmpeg()
          .input(`color=c=${cores[i % cores.length]}:s=1080x1080:d=1`)
          .inputFormat('lavfi')
          .frames(1)
          .output(imgPath)
          .on('end', res).on('error', rej).run();
      });
      imagens.push(imgPath);
    }
    logger.info(`[ECO] ${count} frames coloridos criados como fallback`);
  }

  return imagens;
}

async function gerarSlideshowKenBurns(especialidade, duracao, tmpDir, baseName) {
  const count          = Math.max(4, Math.ceil(duracao / 6)); // 1 imagem a cada ~6s
  const duracaoPorImg  = duracao / count;
  const frames         = Math.round(duracaoPorImg * 30);

  const imagens  = await buscarImagensEco(especialidade, count, tmpDir, baseName);
  const segments = [];

  for (let i = 0; i < imagens.length; i++) {
    const segPath = path.join(tmpDir, `${baseName}_seg_${i}.mp4`);

    // Alterna: zoom-in vs zoom-out + drift horizontal leve
    const zExpr = i % 2 === 0
      ? `min(zoom+0.0006,1.06)`
      : `if(lte(zoom,1.0),1.06,zoom-0.0006)`;

    const xExpr = i % 4 === 0 ? `iw/2-(iw/zoom/2)+8*on/${frames}`
                : i % 4 === 2 ? `iw/2-(iw/zoom/2)-8*on/${frames}`
                : `iw/2-(iw/zoom/2)`;

    await new Promise((res, rej) => {
      ffmpeg()
        .input(imagens[i])
        .inputOptions(['-loop 1'])
        .outputOptions([
          '-t', String(duracaoPorImg),
          '-vf',
          `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
          `zoompan=z='${zExpr}':x='${xExpr}':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1080:fps=30,` +
          `format=yuv420p`,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '22',
          '-pix_fmt', 'yuv420p',
          '-r', '30',
          '-an'
        ])
        .on('end', res)
        .on('error', (err) => {
          logger.warn(`[ECO] Erro no segmento ${i}: ${err.message} — usando cópia direta`);
          // Fallback: imagem estática sem Ken Burns
          ffmpeg()
            .input(imagens[i])
            .inputOptions(['-loop 1'])
            .outputOptions([
              '-t', String(duracaoPorImg),
              '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-r', '30', '-an'
            ])
            .on('end', res).on('error', rej)
            .save(segPath);
        })
        .save(segPath);
    });
    segments.push(segPath);
    logger.info(`[ECO] Segmento ${i + 1}/${imagens.length} criado (Ken Burns)`);
  }

  // Concatenar com xfade suave
  const FADE         = 0.4;
  const outputPath   = path.join(tmpDir, `${baseName}_slideshow.mp4`);

  await new Promise((res, rej) => {
    const cmd = ffmpeg();
    segments.forEach(s => cmd.input(s));

    if (segments.length === 1) {
      cmd.outputOptions(['-c:v copy', '-an']).save(outputPath)
        .on('end', () => {
          try {
            imagens.forEach(p => { try { fs.unlinkSync(p); } catch {} });
            segments.forEach(p => { try { fs.unlinkSync(p); } catch {} });
            res(null);
          } catch (cbErr) { rej(cbErr); }
        })
        .on('error', rej);
      return;
    }

    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < segments.length; i++) {
      const offset = i * (duracaoPorImg - FADE);
      const out    = i === segments.length - 1 ? '[vout]' : `[v${i}]`;
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset}${out}`);
      prev = out;
    }

    cmd.complexFilter(filters.join(';'))
      .outputOptions(['-map [vout]', '-c:v libx264', '-preset fast', '-crf 22', '-r 30', '-pix_fmt yuv420p', '-an'])
      .on('end', () => {
        try {
          imagens.forEach(p => { try { fs.unlinkSync(p); } catch {} });
          segments.forEach(p => { try { fs.unlinkSync(p); } catch {} });
          logger.info(`[ECO] Slideshow montado: ${segments.length} imagens`);
          res(null);
        } catch (cbErr) { rej(cbErr); }
      })
      .on('error', rej)
      .save(outputPath);
  });

  return outputPath;
}

/**
 * Seleciona música de acordo com o contexto do vídeo:
 * hookStyle + funil + especialidade → tom emocional correto
 */
function getMusicPath(funil, hookStyle = 'dor', especialidade = '') {
  // Mapeamento por contexto emocional
  // autoridade / curiosidade → mais clássico/profissional
  // dor / alerta → esperançoso (contraste: problema → solução)
  // erro_comum → leve, positivo
  const porHook = {
    autoridade:   ['mixkit-classical-vibes-2-682.mp3', 'mixkit-bridge-n-98-621.mp3', 'musica_calma.mp3'],
    curiosidade:  ['mixkit-magical-moment-813.mp3', 'mixkit-its-april-847.mp3', 'mixkit-summers-here-91.mp3'],
    dor:          ['musica_esperancosa.mp3', 'mixkit-forever-love-38.mp3', 'mixkit-thats-the-way-of-life-840.mp3'],
    alerta:       ['musica_esperancosa.mp3', 'mixkit-keep-smiling-15.mp3', 'mixkit-feeling-happy-5.mp3'],
    erro_comum:   ['mixkit-smile-1076.mp3', 'mixkit-be-happy-2-823.mp3', 'mixkit-keep-smiling-15.mp3'],
  };

  // Especialidades com conteúdo infantil ganham trilhas mais acolhedoras
  const especialidadeInfantil = ['fonoaudiologia', 'pediatria', 'psicologia_infantil'].some(
    e => especialidade.toLowerCase().includes(e)
  );
  if (especialidadeInfantil) {
    const infantis = ['mixkit-i-love-you-mommy-831.mp3', 'musica_esperancosa.mp3', 'mixkit-magical-moment-813.mp3'];
    const candidatos = hookStyle === 'autoridade'
      ? ['musica_calma.mp3', 'mixkit-classical-vibes-2-682.mp3']
      : infantis;
    const lista = candidatos.filter(f => fs.existsSync(path.join(MUSIC_DIR, f)));
    if (lista.length > 0) {
      const escolhida = lista[Math.floor(Math.random() * lista.length)];
      logger.info(`[VIDEO WORKER] 🎵 Música (infantil/${hookStyle}): ${escolhida}`);
      return path.join(MUSIC_DIR, escolhida);
    }
  }

  const lista = (porHook[hookStyle] || porHook['dor'])
    .filter(f => fs.existsSync(path.join(MUSIC_DIR, f)));

  if (lista.length === 0) return null;

  const escolhida = lista[Math.floor(Math.random() * lista.length)];
  logger.info(`[VIDEO WORKER] 🎵 Música (${hookStyle}/${funil}): ${escolhida}`);
  return path.join(MUSIC_DIR, escolhida);
}

/**
 * Pós-produção premium: narração + legendas + hook + CTA + color grade + fade + logo + música
 */
async function mixarNarracaoLocal(localVideoPath, audioPath, outputPath, funil = 'TOPO', extras = {}) {
  const { hookStyle = 'dor', especialidade = '', intensidade = 'moderado', musicVolume: presetVolume } = extras;

  logger.info(`[VIDEO WORKER] Mixando narração ao vídeo concatenado...`);
  const hasLogo   = fs.existsSync(LOGO_PATH);
  const hasCta    = fs.existsSync(CTA_PATH);
  const musicPath = getMusicPath(funil, hookStyle, especialidade);
  const hasMusic  = !!musicPath;

  if (hasMusic) logger.info(`[VIDEO WORKER] 🎵 Adicionando música: ${path.basename(musicPath)}`);

  const { duracao: duracaoVideo, vidW, vidH } = await new Promise((res, rej) => {
    ffmpeg.ffprobe(localVideoPath, (err, meta) => {
      if (err) return rej(err);
      const vs = meta.streams?.find(s => s.codec_type === 'video');
      res({
        duracao: meta.format.duration || 60,
        vidW:    vs?.width  || 1080,
        vidH:    vs?.height || 1920
      });
    });
  });

  // Detectar duração da narração para truncar vídeo se necessário
  const duracaoNarracao = await new Promise((res, rej) => {
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (err) return rej(err);
      res(meta.format.duration || duracaoVideo);
    });
  });

  // 🎬 Sincronizar vídeo com narração: usar a menor duração + outro
  const OUTRO_DUR = fs.existsSync(LOGO_UNICA_PATH) ? 2 : 0;
  const duracao = Math.min(duracaoVideo, duracaoNarracao);
  
  logger.info(`[VIDEO WORKER] 📊 Duração — Vídeo: ${duracaoVideo.toFixed(1)}s | Narração: ${duracaoNarracao.toFixed(1)}s | Final: ${duracao.toFixed(1)}s + ${OUTRO_DUR}s outro`);

  const ctaInicio    = Math.max(0, duracao - 5);
  const fadeOutStart = Math.max(0, duracao - 0.5);

  const hasOutroLogo = fs.existsSync(LOGO_UNICA_PATH);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(localVideoPath)  // [0]
      .input(audioPath);      // [1]

    const hasOutroSfx = fs.existsSync(OUTRO_SFX_PATH);

    let nextIdx = 2;
    let musicIdx = -1, logoIdx = -1, ctaIdx = -1, outroLogoIdx = -1, sfxIdx = -1;
    if (hasMusic)     { cmd.input(musicPath);       musicIdx     = nextIdx++; }
    if (hasLogo)      { cmd.input(LOGO_PATH);       logoIdx      = nextIdx++; }
    if (hasCta)       { cmd.input(CTA_PATH);        ctaIdx       = nextIdx++; }
    if (hasOutroLogo) { cmd.input(LOGO_UNICA_PATH); outroLogoIdx = nextIdx++; }
    if (hasOutroSfx)  { cmd.input(OUTRO_SFX_PATH);  sfxIdx       = nextIdx++; }

    const filters = [];

    // 1. Truncar vídeo para duração da narração (evita vídeo vazio no final)
    // e aplicar color grading cinematográfico
    filters.push(
      `[0:v]trim=0:${duracao},setpts=PTS-STARTPTS,eq=contrast=1.05:saturation=1.15:brightness=0.02,unsharp=5:5:0.5:5:5:0.0[colored]`
    );

    // 2. Sem legendas no worker — usuário adiciona no editor
    filters.push('[colored]copy[hooked]');

    // 4. Logo overlay pequeno — canto inferior direito
    if (logoIdx !== -1) {
      filters.push(
        `[${logoIdx}:v]scale=110:-1[logo]`,
        `[hooked][logo]overlay=W-w-15:H-h-15[withlogo]`
      );
    } else {
      filters.push('[hooked]copy[withlogo]');
    }

    // 5. CTA card (últimos 5s do conteúdo)
    if (ctaIdx !== -1) {
      filters.push(
        `[${ctaIdx}:v]scale=${vidW}:${vidH}[cta]`,
        `[withlogo][cta]overlay=0:0:enable='gte(t,${ctaInicio})'[precta]`
      );
    } else {
      filters.push('[withlogo]copy[precta]');
    }

    // 6. Fade in/out → produz [mainvid]
    filters.push(
      `[precta]fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOutStart}:d=0.5[mainvid]`
    );

    // 7. Outro final: tela verde + logo centralizado (2s) — usa resolução real do vídeo
    if (outroLogoIdx !== -1) {
      filters.push(
        `color=c=#3f7c67:s=${vidW}x${vidH}:d=2:r=30[bgoutro]`,
        `[${outroLogoIdx}:v]scale=700:-1[logobig]`,
        `[bgoutro][logobig]overlay=(W-w)/2:(H-h)/2[outroframe]`,
        `[mainvid][outroframe]concat=n=2:v=1:a=0[vout]`
      );
    } else {
      filters.push('[mainvid]copy[vout]');
    }

    // 8. Áudio: narração + música + SFX de transição + silêncio para o outro
    const sfxDelay  = Math.round(duracao * 1000); // ms — dispara exatamente na virada do outro

    if (hasMusic) {
      const fadeStart = Math.max(0, duracao - 2);
      // 🎵 Volume da música ajustável por intensidade (conteúdo clínico = mais contido)
      const musicVolume = intensidade === 'viral' ? 0.06 :   // ← Era 0.12, muito alto
                          intensidade === 'forte' ? 0.05 :   // ← Era 0.10
                          0.04;                              // ← Era 0.08, padrão mais suave
      filters.push(
        `[1:a]volume=1.0[voz]`,
        `[${musicIdx}:a]volume=${musicVolume},atrim=0:${duracao + OUTRO_DUR},afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeStart}:d=2[bgm]`,
        `[voz][bgm]amix=inputs=2:duration=first,apad=pad_dur=${OUTRO_DUR}[mixpre]`
      );
    } else {
      filters.push(`[1:a]volume=1.0,apad=pad_dur=${OUTRO_DUR}[mixpre]`);
    }

    if (hasOutroSfx && sfxIdx !== -1) {
      // SFX com delay para começar na virada do outro
      filters.push(
        `[${sfxIdx}:a]volume=0.8,adelay=${sfxDelay}|${sfxDelay}[sfx]`,
        `[mixpre][sfx]amix=inputs=2:duration=first[aout]`
      );
    } else {
      filters.push('[mixpre]copy[aout]');
    }

    cmd
      .complexFilter(filters.join(';'))
      .outputOptions([
        '-map [vout]',
        '-map [aout]',
        '-c:v libx264', '-preset fast', '-crf 22',
        '-c:a aac', '-b:a 128k',
        '-movflags +faststart'
      ])
      .on('end', () => {
        try {
          const features = [hasLogo && 'logo', hasCta && 'CTA', hasMusic && 'música', hasOutroLogo && 'outro'].filter(Boolean).join(' + ');
          logger.info(`[VIDEO WORKER] ✅ Vídeo premium: ${features}`);
          resolve(outputPath);
        } catch (cbErr) {
          logger.error(`[FFMPEG] Erro no callback de sucesso: ${cbErr.message}`);
          reject(cbErr);
        }
      })
      .on('error', (err, stdout, stderr) => {
        logger.error(`[FFMPEG] Erro pós-produção: ${stderr || err.message}`);
        reject(err);
      })
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
    modo = 'avatar',       // 'avatar' | 'ilustrativo' | 'veo' | 'economico'
    tone = 'educativo',    // 'emotional' | 'educativo' | 'inspiracional' | 'bastidores'
    // 🧠 Campos de inteligência de conteúdo
    platform = 'instagram',
    contentType = 'instagram',
    subTema,
    hookStyle = 'dor',
    objetivo = 'salvar',
    variacao,
    intensidade = 'viral',
    bordao = '',           // bordão de abertura ex: "Você sabia" — instrui ZEUS
    roteiroEditado = null,  // roteiro pré-gerado pelo preview (pula ZEUS se fornecido)
    preset = null,          // 🎬 Preset premium: 'explosao_viral', 'autoridade_inspiradora', etc.
    // ⚡ Zeus v3.0
    modoZeus = false,
    zeusConfig = null
  } = job.data;

  // 🎯 Aplicar configurações do preset se fornecido
  let presetConfig = null;
  if (preset) {
    presetConfig = getFullProductionConfig(preset);
    if (presetConfig) {
      logger.info(`[VIDEO WORKER] 🎬 Usando preset PREMIUM: "${presetConfig.nome}"`);
      logger.info(`[VIDEO WORKER] 📊 Config: voz=${presetConfig.tts.voice}, speed=${presetConfig.tts.speed}, vol=${presetConfig.musica.volume}`);
    }
  } else {
    // Auto-recomendar preset baseado nos parâmetros
    const presetRecomendado = recommendPreset(hookStyle, tone, intensidade);
    presetConfig = getFullProductionConfig(presetRecomendado);
    logger.info(`[VIDEO WORKER] 🎬 Preset auto-recomendado: "${presetConfig.nome}" (${hookStyle}+${tone}+${intensidade})`);
  }

  // ⚡ SOBRESCREVER TTS quando Modo Zeus ativo (alinhamento emocional obrigatório)
  // O roteiro Zeus tem tom específico por estágio - o TTS DEVE corresponder
  if (modoZeus && zeusConfig?.estagio_jornada) {
    const ttsZeus = getTTSPorEstagioZeus(zeusConfig.estagio_jornada);
    
    // Sobrescrever configurações de voz do preset
    presetConfig.tts = {
      ...presetConfig.tts,
      voice: ttsZeus.voice,
      speed: ttsZeus.speed,
      tom: ttsZeus.tom,
      pausas: ttsZeus.pausas
    };
    
    logger.info(`[VIDEO WORKER] ⚡ Modo Zeus ativo - TTS ajustado para estágio '${zeusConfig.estagio_jornada}': voz=${ttsZeus.voice}, speed=${ttsZeus.speed}, tom=${ttsZeus.tom}`);
  }

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

      // Evento global para o frontend atualizar a lista sem polling
      if (etapa === 'CONCLUIDO' || etapa === 'ERRO') {
        io.emit('video:status', { jobId, etapa, videoId: videoDocId });
      }
    } catch (e) {
      logger.warn(`[VIDEO WORKER] Erro ao atualizar progresso: ${e.message}`);
    }
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 1: Gerar Roteiro (ZEUS) — ou usar roteiro pré-gerado do preview
    // ═══════════════════════════════════════════════════════════════════════
    await atualizarProgresso('ROTEIRO', 10);

    let roteiro;
    if (roteiroEditado && roteiroEditado.texto_completo) {
      // Roteiro já veio do frontend (usuário editou no modal de preview)
      roteiro = roteiroEditado;
      logger.info(`[VIDEO WORKER] Usando roteiro editado pelo usuário: "${roteiro.titulo}"`);
    } else {
      // ⚡ Parâmetros base (compatibilidade v2.0)
      const baseParams = {
        tema,
        especialidade: especialidadeId,
        funil,
        duracao,
        tone,
        platform,
        subTema,
        hookStyle,
        objetivo,
        variacao: variacao !== undefined ? Number(variacao) : Math.random(),
        intensidade,
        bordao
      };
      
      // ⚡ Se modoZeus ativado, adiciona configurações v3.0
      if (modoZeus && zeusConfig) {
        Object.assign(baseParams, {
          estagio_jornada: zeusConfig.estagio_jornada,
          objecao_principal: zeusConfig.objecao_principal,
          prova_social: zeusConfig.prova_social,
          tipo_conteudo: zeusConfig.tipo_conteudo || 'aquisicao_organica',
          prompt_extra: zeusConfig.promptExtra || null
        });
      }
      
      const result = await gerarRoteiro(baseParams);
      roteiro = result.roteiro;
    }

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
      especialidadeId: roteiro.profissional,
      // 🧠 Metadados de inteligência
      estruturaUsada: roteiro.estrutura_usada || null,
      hookTextoGerado: roteiro.hook_texto_overlay || null,
      legendaInstagram: roteiro.legenda_instagram || null,
      // 🎙️ Configurações de TTS aplicadas (importante para debug)
      ttsConfig: modoZeus ? {
        voice: presetConfig?.tts?.voice,
        speed: presetConfig?.tts?.speed,
        tom: presetConfig?.tts?.tom,
        modoZeus: true,
        estagioJornada: zeusConfig?.estagio_jornada
      } : null
    });

    logger.info(`[VIDEO WORKER] Roteiro gerado: ${roteiro.profissional} | ${roteiro.titulo}`);

    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 2: Gerar Vídeo (Avatar, Ilustrativo ou Veo 3.1)
    // ═══════════════════════════════════════════════════════════════════════
    await atualizarProgresso('HEYGEN', 30);

    let videoCru;

    if (modo === 'teste') {
      // 🧪 MODO TESTE: Usa modo econômico (imagens Pexels + TTS) - CUSTO ZERO/PRATICAMENTE ZERO
      logger.info(`[VIDEO WORKER] 🧪 MODO TESTE ATIVADO - Usando slideshow de imagens (custo ~R$0,02)`);
      logger.info(`[VIDEO WORKER] Para testar flow sem gastar com VEO (R$64). Use preset para ajustar voz/música.`);
      
      // Força modo econômico para teste
      const tmpDirEco = path.join(__dirname, '../tmp/videos');
      fs.mkdirSync(tmpDirEco, { recursive: true });
      const tsEco = Date.now();
      const baseEco = `teste_${tsEco}`;

      await atualizarProgresso('HEYGEN', 35, { etapa: 'GERANDO_SLIDESHOW_TESTE' });
      const slideshowPath = await gerarSlideshowKenBurns(especialidadeId, duracao, tmpDirEco, baseEco);

      await atualizarProgresso('HEYGEN', 55, { etapa: 'GERANDO_NARRACAO_TESTE' });
      const audioEcoPath = path.join(tmpDirEco, `${baseEco}_audio.mp3`);
      logger.info(`[VIDEO WORKER] 🎙️ TTS: voz=${presetConfig?.tts?.voice}, speed=${presetConfig?.tts?.speed}, tom=${presetConfig?.tts?.tom}`);
      
      await gerarNarracaoPTBR(roteiro.texto_completo, audioEcoPath, { 
        tone: presetConfig?.tts?.tom || roteiro.tone || 'educativo',
        intensidade,
        voice: presetConfig?.tts?.voice,
        speed: presetConfig?.tts?.speed
      });

      await atualizarProgresso('POS_PRODUCAO', 65, { etapa: 'MIXANDO_VIDEO_TESTE' });
      const videoEcoFinalPath = path.join(tmpDirEco, `${baseEco}_final.mp4`);
      await mixarNarracaoLocal(slideshowPath, audioEcoPath, videoEcoFinalPath, funil, {
        hookTexto:     roteiro.hook_texto_overlay,
        textoCompleto: roteiro.texto_completo,
        hookStyle,
        especialidade: especialidadeId,
        intensidade
      });
      try { fs.unlinkSync(slideshowPath); fs.unlinkSync(audioEcoPath); } catch {}

      await atualizarProgresso('POS_PRODUCAO', 90, { etapa: 'UPLOAD_TESTE' });
      const cloudinaryEco = (await import('cloudinary')).default;
      const uploadEco = await cloudinaryEco.v2.uploader.upload(videoEcoFinalPath, {
        resource_type: 'video',
        folder: 'fono-inova/ai-videos/teste',  // Pasta separada para testes
        public_id: baseEco,
        overwrite: false
      });
      const videoFinalEcoUrl = uploadEco.secure_url;
      try { fs.unlinkSync(videoEcoFinalPath); } catch {}

      await atualizarProgresso('CONCLUIDO', 100, { 
        status: 'ready', 
        provider: 'teste',
        videoFinalUrl: videoFinalEcoUrl,
        videoUrl: videoFinalEcoUrl,
        'tempos.concluidoEm': new Date()
      });

      const ioEco = getIo();
      ioEco.emit(`video-complete-${jobId}`, { 
        jobId, 
        status: 'CONCLUIDO', 
        videoUrl: videoFinalEcoUrl, 
        roteiro: roteiro.titulo, 
        provider: 'teste',
        modoTeste: true,
        custo: 'GRATUITO / R$0,02'
      });

      logger.info(`[VIDEO WORKER] ✅ ${jobId} MODO TESTE CONCLUÍDO - Custo: GRATUITO`);
      return {
        jobId,
        status: 'CONCLUIDO',
        roteiro: { titulo: roteiro.titulo, profissional: roteiro.profissional, duracao: roteiro.duracao_estimada },
        videoFinal: videoFinalEcoUrl,
        provider: 'teste',
        modoTeste: true,
        meta: null
      };
    }

    if (modo === 'veo') {
      // 🎬 Modo VEO: Google Veo 2.0 — vídeo cinematográfico real (CUSTO R$64)
      logger.info(`[VIDEO WORKER] Modo VEO 2.0 - Google AI (cinematográfico) ~R$64`);

      if (!isVeoConfigured()) {
        throw new Error('GOOGLE_AI_API_KEY não configurado. Acesse aistudio.google.com para obter gratuitamente.');
      }

      // 🚨 PROTEÇÃO ABSOLUTA: Modo teste/econômico nunca usa VEO (custo R$64/clip)
      if (modo === 'teste' || modo === 'economico') {
        throw new Error(`[VIDEO WORKER] BLOQUEIO DE SEGURANÇA: Modo '${modo}' não pode usar VEO. Use slideshow.`);
      }

      // Calcula quantos clips de 8s são necessários para cobrir a duração solicitada
      // Ex: 30s → ceil(30/8) = 4 clips (32s efetivos) — máx 6 clips (48s) para Instagram
      const numClips = Math.min(6, Math.max(1, Math.ceil(duracao / 8)));
      const duracaoEfetiva = numClips * 8;
      logger.info(`[VIDEO WORKER] Gerando ${numClips} clip(s) Veo de 8s → ${duracaoEfetiva}s de conteúdo (solicitado: ${duracao}s)`);

      // Gera clips sequencialmente para respeitar rate limits da API Veo
      // (geração paralela causa 429 RESOURCE_EXHAUSTED com múltiplos clips)
      const veoService = new VeoService();

      // Retomar de onde parou: carrega clips já gerados em tentativas anteriores
      const videoDoc = await Video.findById(videoDocId).select('clipsGerados numClipsTotal').lean();
      const clipUrls = videoDoc?.clipsGerados?.length > 0 ? [...videoDoc.clipsGerados] : [];
      const startClip = clipUrls.length;

      if (startClip > 0) {
        logger.info(`[VIDEO WORKER] 🔁 Retomando geração: ${startClip}/${numClips} clips já prontos, continuando do clip ${startClip + 1}...`);
      }

      // Salva total esperado no banco (para monitoramento)
      await Video.findByIdAndUpdate(videoDocId, { numClipsTotal: numClips });

      for (let i = startClip; i < numClips; i++) {
        const progressoGeracao = 30 + Math.round((i / numClips) * 38); // 30% → 68%
        await atualizarProgresso('HEYGEN', progressoGeracao);
        logger.info(`[VIDEO WORKER] Gerando clip ${i + 1}/${numClips}...`);

        let tentativa = 0;
        while (true) {
          try {
            const result = await veoService.gerarVideo(especialidadeId, tema || null, { durationSeconds: 8, aspectRatio: '1:1', clipIndex: i, intensidade, modo });
            clipUrls.push(result.url);
            // Persiste o clip imediatamente — se o job travar nos próximos, retomamos daqui
            await Video.findByIdAndUpdate(videoDocId, { $push: { clipsGerados: result.url } });
            logger.info(`[VIDEO WORKER] ✅ Clip ${i + 1}/${numClips} gerado e salvo`);
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
      await gerarNarracaoPTBR(roteiro.texto_completo, audioPath, { 
        tone: presetConfig?.tts?.tom || roteiro.tone || 'educativo',
        intensidade: presetConfig?.tts?.speed > 1.02 ? 'viral' : intensidade,
        voice: presetConfig?.tts?.voice,
        speed: presetConfig?.tts?.speed
      });

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

      // Mixar narração + pós-produção premium
      await atualizarProgresso('POS_PRODUCAO', 87, { etapa: 'MIXANDO_AUDIO' });
      await mixarNarracaoLocal(concatPath, audioPath, videoFinalPath, funil, {
        hookTexto:     roteiro.hook_texto_overlay,
        textoCompleto: roteiro.texto_completo,
        hookStyle,
        especialidade: especialidadeId,
        intensidade
      });
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

    } else if (modo === 'runway') {
      // Kling AI — vídeo cinematográfico
      logger.info(`[VIDEO WORKER] Modo RUNWAY - Kling AI (cinematográfico)`);

      if (!isKlingConfigured()) {
        throw new Error('RUNWAY_ACCESS_KEY_ID ou RUNWAY_ACCESS_KEY_SECRET não configurados.');
      }

      const numClips = Math.min(5, Math.max(1, Math.ceil(duracao / RUNWAY_CLIP_DURATION))); // máx 50s
      const duracaoEfetiva = numClips * RUNWAY_CLIP_DURATION;
      logger.info(`[VIDEO WORKER] Gerando ${numClips} clip(s) Kling de ${RUNWAY_CLIP_DURATION}s → ${duracaoEfetiva}s (solicitado: ${duracao}s)`);

      const runwayService = new RunwayService();

      // Retomar de onde parou
      const videoDocKling = await Video.findById(videoDocId).select('clipsGerados numClipsTotal').lean();
      const clipUrls = videoDocKling?.clipsGerados?.length > 0 ? [...videoDocKling.clipsGerados] : [];
      const startClipKling = clipUrls.length;

      if (startClipKling > 0) {
        logger.info(`[VIDEO WORKER] 🔁 Retomando Kling: ${startClipKling}/${numClips} clips já prontos`);
      }

      await Video.findByIdAndUpdate(videoDocId, { numClipsTotal: numClips });

      for (let i = startClipKling; i < numClips; i++) {
        const progressoGeracao = 30 + Math.round((i / numClips) * 38);
        await atualizarProgresso('HEYGEN', progressoGeracao);
        logger.info(`[VIDEO WORKER] Gerando clip Kling ${i + 1}/${numClips}...`);
        const result = await runwayService.gerarVideo(especialidadeId, tema || null, { clipIndex: i });
        clipUrls.push(result.url);
        await Video.findByIdAndUpdate(videoDocId, { $push: { clipsGerados: result.url } });
        logger.info(`[VIDEO WORKER] Clip Kling ${i + 1}/${numClips} gerado e salvo`);
      }

      videoCru = clipUrls[0];

      await atualizarProgresso('HEYGEN', 70, {
        videoCruUrl: videoCru,
        videoFinalUrl: videoCru,
        videoUrl: videoCru,
        status: 'processing',
        provider: 'runway'
      });

      const tmpDirKling = path.join(__dirname, '../tmp/videos');
      fs.mkdirSync(tmpDirKling, { recursive: true });
      const tsKling = Date.now();

      const audioPathKling     = path.join(tmpDirKling, `runway_narracao_${tsKling}.mp3`);
      const concatPathKling    = path.join(tmpDirKling, `runway_concat_${tsKling}.mp4`);
      const videoFinalPathKling = path.join(tmpDirKling, `runway_final_${tsKling}.mp4`);

      await atualizarProgresso('POS_PRODUCAO', 73, { etapa: 'GERANDO_NARRACAO' });
      await gerarNarracaoPTBR(roteiro.texto_completo, audioPathKling, { 
        tone: presetConfig?.tts?.tom || roteiro.tone || 'educativo',
        intensidade: presetConfig?.tts?.speed > 1.02 ? 'viral' : intensidade,
        voice: presetConfig?.tts?.voice,
        speed: presetConfig?.tts?.speed
      });

      await atualizarProgresso('POS_PRODUCAO', 80, { etapa: 'CONCATENANDO_CLIPS' });
      if (numClips > 1) {
        await concatenarClipsVeo(clipUrls, concatPathKling);
      } else {
        const videoResponse = await axios.get(clipUrls[0], { responseType: 'arraybuffer', httpsAgent: ipv4HttpsAgent });
        fs.writeFileSync(concatPathKling, Buffer.from(videoResponse.data));
      }

      await atualizarProgresso('POS_PRODUCAO', 87, { etapa: 'MIXANDO_AUDIO' });
      await mixarNarracaoLocal(concatPathKling, audioPathKling, videoFinalPathKling, funil, {
        hookTexto:     roteiro.hook_texto_overlay,
        textoCompleto: roteiro.texto_completo,
        hookStyle,
        especialidade: especialidadeId,
        intensidade
      });
      try { fs.unlinkSync(concatPathKling); } catch {}

      await atualizarProgresso('POS_PRODUCAO', 93, { etapa: 'UPLOAD_CLOUDINARY' });
      const cloudinaryKling = (await import('cloudinary')).default;
      const uploadResultKling = await cloudinaryKling.v2.uploader.upload(videoFinalPathKling, {
        resource_type: 'video',
        folder: 'fono-inova/ai-videos/runway',
        public_id: `runway_narrado_${tsKling}`,
        overwrite: false
      });
      const videoFinalKling = uploadResultKling.secure_url;

      try { fs.unlinkSync(audioPathKling); fs.unlinkSync(videoFinalPathKling); } catch {}

      await atualizarProgresso('POS_PRODUCAO', 95, {
        videoFinalUrl: videoFinalKling,
        videoUrl: videoFinalKling
      });

      await atualizarProgresso('CONCLUIDO', 100, {
        status: 'ready',
        provider: 'runway',
        'tempos.concluidoEm': new Date()
      });

      const ioKling = getIo();
      ioKling.emit(`video-complete-${jobId}`, {
        jobId,
        status: 'CONCLUIDO',
        videoUrl: videoFinalKling,
        roteiro: roteiro.titulo,
        provider: 'runway'
      });

      logger.info(`[VIDEO WORKER] ${jobId} RUNWAY concluído (${numClips} clip(s), ${Math.round((Date.now() - job.timestamp) / 1000)}s total)`);
      return {
        jobId,
        status: 'CONCLUIDO',
        roteiro: { titulo: roteiro.titulo, profissional: roteiro.profissional, duracao: roteiro.duracao_estimada },
        videoFinal: videoFinalKling,
        provider: 'runway',
        meta: null
      };

    } else if (modo === 'economico') {
      // Imagens Ken Burns + TTS narração + pós-produção premium (~R$0,20/video)
      logger.info(`[VIDEO WORKER] Modo ECONOMICO - Slideshow Ken Burns + TTS + premium`);

      const tmpDirEco = path.join(__dirname, '../tmp/videos');
      fs.mkdirSync(tmpDirEco, { recursive: true });
      const tsEco     = Date.now();
      const baseEco   = `eco_${tsEco}`;

      await atualizarProgresso('HEYGEN', 35);
      const slideshowPath = await gerarSlideshowKenBurns(especialidadeId, duracao, tmpDirEco, baseEco);

      await atualizarProgresso('HEYGEN', 55);
      const audioEcoPath = path.join(tmpDirEco, `${baseEco}_audio.mp3`);
      await gerarNarracaoPTBR(roteiro.texto_completo, audioEcoPath, { 
        tone: presetConfig?.tts?.tom || roteiro.tone || 'educativo',
        intensidade: presetConfig?.tts?.speed > 1.02 ? 'viral' : intensidade,
        voice: presetConfig?.tts?.voice,
        speed: presetConfig?.tts?.speed
      });

      await atualizarProgresso('POS_PRODUCAO', 65);
      const videoEcoFinalPath = path.join(tmpDirEco, `${baseEco}_final.mp4`);
      await mixarNarracaoLocal(slideshowPath, audioEcoPath, videoEcoFinalPath, funil, {
        hookTexto:     roteiro.hook_texto_overlay,
        textoCompleto: roteiro.texto_completo,
        hookStyle,
        especialidade: especialidadeId,
        intensidade
      });
      try { fs.unlinkSync(slideshowPath); fs.unlinkSync(audioEcoPath); } catch {}

      await atualizarProgresso('POS_PRODUCAO', 90);
      const cloudinaryEco = (await import('cloudinary')).default;
      const uploadEco     = await cloudinaryEco.v2.uploader.upload(videoEcoFinalPath, {
        resource_type: 'video',
        folder: 'fono-inova/ai-videos/economico',
        public_id: baseEco,
        overwrite: false
      });
      const videoFinalEcoUrl = uploadEco.secure_url;
      try { fs.unlinkSync(videoEcoFinalPath); } catch {}

      await atualizarProgresso('POS_PRODUCAO', 95, { videoFinalUrl: videoFinalEcoUrl, videoUrl: videoFinalEcoUrl });
      await atualizarProgresso('CONCLUIDO', 100, { status: 'ready', provider: 'economico', 'tempos.concluidoEm': new Date() });

      const ioEco = getIo();
      ioEco.emit(`video-complete-${jobId}`, { jobId, status: 'CONCLUIDO', videoUrl: videoFinalEcoUrl, roteiro: roteiro.titulo, provider: 'economico' });

      logger.info(`[VIDEO WORKER] ✅ ${jobId} ECONOMICO concluido (${Math.round((Date.now() - job.timestamp) / 1000)}s)`);
      return {
        jobId,
        status: 'CONCLUIDO',
        roteiro: { titulo: roteiro.titulo, profissional: roteiro.profissional, duracao: roteiro.duracao_estimada },
        videoFinal: videoFinalEcoUrl,
        provider: 'economico',
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

    // 🔁 Auto-multiplicar: criar post Instagram derivado do vídeo
    if (platform === 'instagram' || !platform) {
      try {
        const funnelStage = funil?.toLowerCase() === 'topo' ? 'top' : funil?.toLowerCase() === 'fundo' ? 'bottom' : 'middle';
        const igPost = await InstagramPost.create({
          title: roteiro.titulo,
          content: roteiro.legenda_instagram || roteiro.textoCompleto || roteiro.titulo,
          caption: roteiro.legenda_instagram || null,
          theme: especialidadeId,
          funnelStage,
          mediaType: 'video',
          mediaUrl: videoFinal,
          aiGenerated: true,
          tone: tone || 'emotional',
          status: 'draft',
          processingStatus: 'completed',
          createdBy: userId || null
        });
        const postJobId = `post_ig_from_video_${Date.now()}`;
        await postGenerationQueue.add('generate-post', {
          postId: igPost._id.toString(),
          channel: 'instagram',
          especialidadeId,
          customTheme: roteiro.titulo,
          funnelStage,
          generateImage: false,
          userId,
          tone,
          sourceVideoId: videoDocId,
          sourceVideoUrl: videoFinal,
          legenda: roteiro.legenda_instagram,
          hashtags: roteiro.hashtags
        }, { jobId: postJobId });
        logger.info(`[VIDEO WORKER] Post Instagram criado e enfileirado: ${igPost._id} / ${postJobId}`);
      } catch (postErr) {
        logger.warn(`[VIDEO WORKER] Falha ao criar post Instagram (não crítico): ${postErr.message}`);
      }
    }

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

videoWorker.on('failed', async (job, err) => {
  const errorMsg = err?.message || err?.toString() || 'Erro desconhecido';
  logger.error(`[VIDEO WORKER] ❌ Job ${job?.id} falhou: ${errorMsg}`);
  
  // Atualizar status no MongoDB quando job falha (incluindo stalled jobs)
  if (job?.data?.videoDocId) {
    try {
      await Video.findByIdAndUpdate(job.data.videoDocId, {
        status: 'failed',
        pipelineStatus: 'ERRO',
        errorMessage: `[WORKER FAILED] ${errorMsg.substring(0, 500)}`,
        'progresso.etapa': 'ERRO',
        'progresso.percentual': 0,
        'progresso.atualizadoEm': new Date()
      });
      logger.info(`[VIDEO WORKER] ✅ Status do vídeo ${job.data.videoDocId} atualizado para 'failed'`);
      
      // Emitir evento de erro via socket
      const io = getIo();
      io.emit(`video-progress-${job.data.jobId}`, {
        jobId: job.data.jobId,
        etapa: 'ERRO',
        percentual: 0,
        erro: errorMsg
      });
    } catch (dbErr) {
      logger.error(`[VIDEO WORKER] ❌ Falha ao atualizar status no MongoDB: ${dbErr.message}`);
    }
  }
});

videoWorker.on('error', (err) => {
  logger.error('[VIDEO WORKER] Erro no worker:', err.message);
});

logger.info('[VIDEO WORKER] 🎬 Worker inicializado (concurrency: 1)');

// ─────────────────────────────────────────────────────────────────────────────
// WORKER DE POS-PRODUCAO (legendas, música, CTA aplicados manualmente)
// ─────────────────────────────────────────────────────────────────────────────

const posProducaoWorker = new Worker('pos-producao', async (job) => {
  const {
    videoId,
    videoUrl,
    roteiro,
    legendas,
    musica,
    musicVolume,
    cta,
    logo,
    logoPosition,
    watermarkText,
    trimStart,
    trimEnd,
    subtitleFontSize,
    subtitleFontColor
  } = job.data;

  logger.info(`[POS-PRODUCAO WORKER] Iniciando edição vídeo ${videoId}`);

  try {
    const editadoUrl = await aplicarPosProducao({
      videoId,
      videoUrl,
      roteiro,
      legendas,
      musica,
      musicVolume,
      cta,
      logo,
      logoPosition,
      watermarkText,
      trimStart,
      trimEnd,
      subtitleFontSize,
      subtitleFontColor
    });

    await Video.findByIdAndUpdate(videoId, {
      videoEditadoUrl: editadoUrl,
      posProducaoStatus: 'ready',
      'posProducaoConfig.aplicadoEm': new Date()
    });

    const io = getIo();
    io.emit('video:status', { videoId, etapa: 'POS_PRODUCAO_CONCLUIDA' });

    logger.info(`[POS-PRODUCAO WORKER] Vídeo ${videoId} editado: ${editadoUrl}`);
    return { videoId, editadoUrl };

  } catch (err) {
    logger.error(`[POS-PRODUCAO WORKER] Erro vídeo ${videoId}: ${err.message}`);
    await Video.findByIdAndUpdate(videoId, {
      posProducaoStatus: 'failed',
      posProducaoError: err.message
    }).catch(() => {});
    throw err;
  }
}, {
  connection: redisConnection,
  concurrency: 2
});

posProducaoWorker.on('failed', (job, err) => {
  logger.error(`[POS-PRODUCAO WORKER] Job ${job?.id} falhou: ${err.message}`);
});

posProducaoWorker.on('error', (err) => {
  logger.error('[POS-PRODUCAO WORKER] Erro no worker:', err.message);
});

logger.info('[POS-PRODUCAO WORKER] Worker inicializado (concurrency: 2)');

export default videoWorker;
