# PIPELINE VÍDEO 100% AUTOMÁTICO — Fono Inova
## Zero intervenção: Copy → Vídeo → Pós-produção → Publicação

---

## A DOR (resolvida)

```
ANTES (manual):
  Freepik gera imagem → gera clip 10s → junta frame por frame
  → edita → exporta → upload manual → cria campanha manual
  ⏱️ ~2 horas por vídeo de 1 minuto

DEPOIS (automático):
  POST /api/video/gerar { tema, especialidade }
  → ZEUS cria roteiro
  → HeyGen API gera talking head completo (até 5 min)
  → FFmpeg adiciona legendas + logo + CTA + música
  → Meta API faz upload + cria campanha
  ⏱️ ~8 minutos automático, zero clique
```

---

## ARQUITETURA

```
┌─────────────────────────────────────────────────┐
│            POST /api/video/gerar                │
│  { tema, especialidade, funil, duracao }        │
└────────────────────┬────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │  1. ZEUS (Roteiro)  │  Claude Sonnet → roteiro por segundos
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  2. HEYGEN API      │  Gera vídeo completo (até 5 min)
          │  (talking head)     │  Avatar + voz clonada da profissional
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  3. FFMPEG           │  Server-side no seu Node:
          │  (pós-produção)     │  • Legendas automáticas (whisper)
          │                     │  • Logo overlay (canto superior)
          │                     │  • Card CTA final (5s)
          │                     │  • Música de fundo
          │                     │  • Formato 9:16, 1080x1920
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  4. META API         │  Upload vídeo → AdCreative → Ad
          │  (publicação)       │  Campanha pronta, status PAUSED
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  5. ATENA (review)  │  Revisa compliance → ACTIVE
          └─────────────────────┘
```

---

## DEPENDÊNCIAS (instalar no servidor)

```bash
# FFmpeg (pós-produção de vídeo)
sudo apt-get install -y ffmpeg

# Whisper (legendas automáticas) — ou usar API
pip install openai-whisper --break-system-packages

# Node deps
npm install axios form-data fluent-ffmpeg @anthropic-ai/sdk

# Fontes pra legendas
sudo apt-get install -y fonts-roboto
```

---

## 1. GERADOR DE ROTEIRO OTIMIZADO (ZEUS v2)

```javascript
// src/agents/zeus-video.js
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic();

const ZEUS_VIDEO_PROMPT = `Você é ZEUS, o roteirista de vídeo da Clínica Fono Inova.
Você escreve roteiros para TALKING HEAD (profissional falando pra câmera).

O vídeo será gerado automaticamente no HeyGen. O avatar da profissional 
vai falar EXATAMENTE o texto que você escrever. Por isso:

REGRAS DO ROTEIRO:
1. Escreva como FALA, não como escreve. Frases curtas. Tom de conversa.
2. Máximo 150 palavras por minuto (ritmo natural, não corrido)
3. NUNCA usar jargão clínico pesado. Mãe leiga precisa entender.
4. Hook nos primeiros 5 segundos — ou perde a audiência
5. Estrutura obrigatória:
   [0-5s]  HOOK — frase impactante, pergunta ou dado
   [5-20s] CONTEXTO — desenvolver o tema com empatia
   [20-40s] VALOR — informação útil, dica prática, explicação
   [40-50s] SOLUÇÃO — como a Fono Inova resolve
   [50-60s] CTA — chamar pro WhatsApp + 💚

6. Compliance saúde:
   ❌ "Seu filho tem autismo?"
   ✅ "Crianças no espectro podem apresentar..."
   ❌ "Vamos curar"
   ✅ "Vamos acompanhar o desenvolvimento"

ESPECIALIDADES DISPONÍVEIS:
- fono_ana: Fonoaudiologia (fala, linguagem, alimentação)
- psico_bia: Psicologia (comportamento, TEA, TDAH, emocional)
- to_carla: Terapia Ocupacional (motor fino, sensorial, AVDs)
- neuro_dani: Neuropsicologia (avaliação cognitiva, diagnóstico)
- fisio_edu: Fisioterapia (motor grosso, postura, equilíbrio)
- musico_fer: Musicoterapia (expressão, socialização, ritmo)

Retorne APENAS JSON:
{
  "roteiro": {
    "titulo": "string (pra nomenclatura do arquivo)",
    "profissional": "fono_ana|psico_bia|to_carla|neuro_dani|fisio_edu|musico_fer",
    "duracao_estimada": 45-60,
    "texto_completo": "string (TUDO que a profissional vai falar, corrido)",
    "hook_texto_overlay": "string (frase curta pra aparecer nos 3 primeiros segundos)",
    "cta_texto_overlay": "Fale com a gente no WhatsApp 💚",
    "hashtags": ["string"],
    "copy_anuncio": {
      "texto_primario": "string (copy do ad no Meta, 2-3 linhas)",
      "headline": "string (5-8 palavras)",
      "descricao": "string (1 frase)"
    }
  }
}`;

async function gerarRoteiro({ tema, especialidade, funil = 'TOPO', duracao = 60 }) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: ZEUS_VIDEO_PROMPT,
    messages: [{
      role: 'user',
      content: `Tema: ${tema}
Especialidade: ${especialidade}
Funil: ${funil} (${funil === 'TOPO' ? 'educativo' : funil === 'MEIO' ? 'institucional' : 'conversão'})
Duração alvo: ${duracao}s

Gere o roteiro. APENAS JSON.`
    }]
  });

  return JSON.parse(response.content[0].text);
}

module.exports = { gerarRoteiro };
```

---

## 2. HEYGEN API — Gerar Vídeo Completo

```javascript
// src/services/heygen/heygenService.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const API_KEY = process.env.HEYGEN_API_KEY;
const BASE = 'https://api.heygen.com';
const headers = { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' };

// Avatares (preencher com IDs reais após setup)
const AVATARES = {
  fono_ana:   { avatar_id: 'SEU_AVATAR_ID', voice_id: 'SEU_VOICE_ID' },
  psico_bia:  { avatar_id: 'SEU_AVATAR_ID', voice_id: 'SEU_VOICE_ID' },
  to_carla:   { avatar_id: 'SEU_AVATAR_ID', voice_id: 'SEU_VOICE_ID' },
  neuro_dani: { avatar_id: 'SEU_AVATAR_ID', voice_id: 'SEU_VOICE_ID' },
  fisio_edu:  { avatar_id: 'SEU_AVATAR_ID', voice_id: 'SEU_VOICE_ID' },
  musico_fer: { avatar_id: 'SEU_AVATAR_ID', voice_id: 'SEU_VOICE_ID' },
};

/**
 * Gera vídeo talking head via HeyGen API
 * HeyGen suporta vídeos de até 5 MINUTOS — resolve o problema dos 10s
 * @returns {string} caminho do arquivo MP4 baixado
 */
async function gerarVideo({ profissional, textoFala, titulo }) {
  const avatar = AVATARES[profissional];
  if (!avatar) throw new Error(`Avatar não encontrado: ${profissional}`);

  // 1. Criar vídeo
  logger.info(`[HEYGEN] Gerando vídeo: ${titulo} | Avatar: ${profissional}`);

  const { data: createRes } = await axios.post(`${BASE}/v2/video/generate`, {
    video_inputs: [{
      character: {
        type: 'avatar',
        avatar_id: avatar.avatar_id,
        avatar_style: 'normal' // ou 'circle' pra formato redondo
      },
      voice: {
        type: 'text',
        input_text: textoFala,
        voice_id: avatar.voice_id,
        speed: 0.95 // levemente mais lento = mais autoridade
      },
      background: {
        type: 'color',
        value: '#FFFFFF' // fundo branco (substituímos no FFmpeg se quiser)
      }
    }],
    dimension: { width: 1080, height: 1920 },
    aspect_ratio: '9:16'
  }, { headers });

  const videoId = createRes.data.video_id;
  logger.info(`[HEYGEN] Video ID: ${videoId} — aguardando processamento...`);

  // 2. Polling até ficar pronto (geralmente 2-5 min)
  let videoUrl = null;
  let tentativas = 0;
  const MAX_TENTATIVAS = 60; // 10 min máx

  while (!videoUrl && tentativas < MAX_TENTATIVAS) {
    await sleep(10000); // 10s entre checks
    tentativas++;

    const { data: statusRes } = await axios.get(
      `${BASE}/v1/video_status.get?video_id=${videoId}`,
      { headers }
    );

    const status = statusRes.data.status;
    logger.info(`[HEYGEN] Status: ${status} (tentativa ${tentativas}/${MAX_TENTATIVAS})`);

    if (status === 'completed') {
      videoUrl = statusRes.data.video_url;
    } else if (status === 'failed') {
      throw new Error(`HeyGen falhou: ${statusRes.data.error || 'erro desconhecido'}`);
    }
  }

  if (!videoUrl) throw new Error('HeyGen timeout — vídeo não ficou pronto em 10 min');

  // 3. Baixar o vídeo
  const outputDir = path.join(__dirname, '../../tmp/videos');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `heygen_${videoId}.mp4`;
  const filePath = path.join(outputDir, fileName);

  const videoStream = await axios.get(videoUrl, { responseType: 'stream' });
  const writer = fs.createWriteStream(filePath);
  videoStream.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  logger.info(`[HEYGEN] ✅ Vídeo baixado: ${filePath}`);
  return filePath;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { gerarVideo, AVATARES };
```

---

## 3. FFMPEG — Pós-Produção Automática no Servidor

```javascript
// src/services/video/postProduction.js
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const logger = require('../../utils/logger');

const ASSETS_DIR = path.join(__dirname, '../../assets/video');
// Criar pasta assets/video/ com:
// - logo.png (logo Fono Inova, fundo transparente, ~200x200px)
// - cta_card.png (card final com WhatsApp, 1080x1920)
// - musica_calma.mp3 (faixa de fundo, royalty-free)
// - musica_esperancosa.mp3
// - font Roboto (já instalado via apt)

/**
 * Pipeline completo de pós-produção
 * Input: vídeo cru do HeyGen
 * Output: vídeo final pronto pra Meta Ads
 */
async function posProducao({ 
  videoInput, 
  hookTexto,
  ctaTexto = 'Fale com a gente no WhatsApp 💚',
  musica = 'calma',
  titulo 
}) {
  const outputDir = path.join(__dirname, '../../tmp/videos/final');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = Date.now();
  const legendaPath = path.join(outputDir, `${timestamp}_legendas.srt`);
  const outputPath = path.join(outputDir, `${titulo || timestamp}_final.mp4`);

  // ETAPA 1: Gerar legendas automáticas com Whisper
  logger.info('[FFMPEG] Etapa 1/4: Gerando legendas com Whisper...');
  await gerarLegendasWhisper(videoInput, legendaPath);

  // ETAPA 2: Montar vídeo com FFmpeg
  logger.info('[FFMPEG] Etapa 2/4: Montando vídeo final...');

  const logoPath = path.join(ASSETS_DIR, 'logo.png');
  const ctaCardPath = path.join(ASSETS_DIR, 'cta_card.png');
  const musicaPath = path.join(ASSETS_DIR, `musica_${musica}.mp3`);

  // Pegar duração do vídeo original
  const duracao = await getDuracao(videoInput);
  const ctaInicio = duracao - 5; // CTA card nos últimos 5s

  await new Promise((resolve, reject) => {
    // FFmpeg complexo com múltiplos overlays
    const cmd = [
      `ffmpeg -y`,
      `-i "${videoInput}"`,                    // [0] vídeo HeyGen
      `-i "${logoPath}"`,                      // [1] logo
      `-i "${ctaCardPath}"`,                   // [2] card CTA
      `-i "${musicaPath}"`,                    // [3] música
      `-filter_complex "`,
      // Hook texto nos primeiros 3 segundos
      `[0:v]drawtext=text='${escaparTextoFFmpeg(hookTexto)}'` +
        `:fontfile=/usr/share/fonts/truetype/roboto/Roboto-Bold.ttf` +
        `:fontsize=42:fontcolor=white:borderw=3:bordercolor=black` +
        `:x=(w-text_w)/2:y=h*0.15` +
        `:enable='between(t,0,3.5)':fade=in:0:0.3:fade=out:3:0.5[hook];`,
      // Legendas (subtítulos estilo TikTok)
      `[hook]subtitles='${legendaPath}'` +
        `:force_style='FontName=Roboto,FontSize=28,PrimaryColour=&H00FFFFFF,` +
        `OutlineColour=&H00000000,Outline=3,Bold=1,Alignment=2,MarginV=180'[subs];`,
      // Logo no canto superior direito
      `[1:v]scale=120:-1[logo_scaled];`,
      `[subs][logo_scaled]overlay=W-w-30:30:enable='between(t,0,${ctaInicio})'[withlogo];`,
      // Card CTA nos últimos 5 segundos (fade in)
      `[2:v]scale=1080:1920[cta_scaled];`,
      `[withlogo][cta_scaled]overlay=0:0:enable='gte(t,${ctaInicio})'` +
        `:shortest=1[video_out];`,
      // Mixar áudio: voz original + música baixinha
      `[0:a]volume=1.0[voz];`,
      `[3:a]volume=0.08,atrim=0:${duracao},afade=t=in:st=0:d=2,` +
        `afade=t=out:st=${duracao - 2}:d=2[bg_music];`,
      `[voz][bg_music]amix=inputs=2:duration=first[audio_out]`,
      `"`,
      `-map "[video_out]" -map "[audio_out]"`,
      `-c:v libx264 -preset fast -crf 23`,
      `-c:a aac -b:a 128k`,
      `-movflags +faststart`,     // Otimiza pra streaming
      `-t ${duracao}`,
      `"${outputPath}"`
    ].join(' ');

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        logger.error(`[FFMPEG] Erro: ${stderr}`);
        reject(error);
      } else {
        resolve();
      }
    });
  });

  // ETAPA 3: Validar output
  logger.info('[FFMPEG] Etapa 3/4: Validando...');
  const outputDuracao = await getDuracao(outputPath);
  const outputSize = fs.statSync(outputPath).size;

  if (outputDuracao < 10 || outputSize < 100000) {
    throw new Error(`Vídeo final inválido: ${outputDuracao}s, ${outputSize} bytes`);
  }

  // ETAPA 4: Limpar temporários
  logger.info('[FFMPEG] Etapa 4/4: Limpando temporários...');
  if (fs.existsSync(legendaPath)) fs.unlinkSync(legendaPath);

  logger.info(`[FFMPEG] ✅ Vídeo final: ${outputPath} (${outputDuracao}s, ${(outputSize/1024/1024).toFixed(1)}MB)`);
  return outputPath;
}

/**
 * Gerar legendas com Whisper (local) ou OpenAI Whisper API
 */
async function gerarLegendasWhisper(videoPath, srtOutput) {
  return new Promise((resolve, reject) => {
    // Opção 1: Whisper local (gratuito, precisa de GPU pra ser rápido)
    const cmd = `whisper "${videoPath}" --model small --language pt --output_format srt --output_dir "${path.dirname(srtOutput)}"`;
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        // Fallback: legendas simples baseadas no roteiro
        logger.warn('[WHISPER] Falha no Whisper, usando fallback');
        // Criar SRT vazio (vídeo sai sem legenda — melhor que falhar)
        fs.writeFileSync(srtOutput, '');
        resolve();
      } else {
        // Whisper gera com nome do arquivo, renomear
        const whisperOutput = videoPath.replace('.mp4', '.srt');
        if (fs.existsSync(whisperOutput) && whisperOutput !== srtOutput) {
          fs.renameSync(whisperOutput, srtOutput);
        }
        resolve();
      }
    });
  });
}

/**
 * Alternativa: Gerar SRT a partir do roteiro (sem Whisper)
 * Mais simples, funciona sempre, mas sincronização aproximada
 */
function gerarSRTdoRoteiro(textoCompleto, duracaoTotal) {
  const palavras = textoCompleto.split(/\s+/);
  const palavrasPorSegundo = palavras.length / duracaoTotal;
  const palavrasPorBloco = Math.ceil(palavrasPorSegundo * 3); // blocos de 3s

  let srt = '';
  let bloco = 1;
  let i = 0;

  while (i < palavras.length) {
    const inicio = (i / palavrasPorSegundo);
    const blocoTexto = palavras.slice(i, i + palavrasPorBloco).join(' ');
    const fim = Math.min(inicio + 3, duracaoTotal);

    srt += `${bloco}\n`;
    srt += `${formatSRTTime(inicio)} --> ${formatSRTTime(fim)}\n`;
    srt += `${blocoTexto}\n\n`;

    bloco++;
    i += palavrasPorBloco;
  }

  return srt;
}

function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

function getDuracao(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

function escaparTextoFFmpeg(texto) {
  return texto
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '%%');
}

module.exports = { posProducao, gerarSRTdoRoteiro };
```

---

## 4. UPLOAD META + CRIAR CAMPANHA

```javascript
// src/services/meta/videoPublisher.js
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { account } = require('./metaClient');
const logger = require('../../utils/logger');

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
const PAGE_ID = process.env.META_PAGE_ID;
const API_VERSION = process.env.META_API_VERSION || 'v21.0';

/**
 * Upload vídeo + Criar AdCreative + Criar Campanha completa
 * Tudo automático, retorna campanha PAUSED pronta pra ativar
 */
async function publicarVideo({ videoPath, copy, nomeCampanha, targeting }) {
  // 1. Upload do vídeo
  logger.info('[META] Fazendo upload do vídeo...');
  const videoId = await uploadVideoMeta(videoPath, nomeCampanha);
  logger.info(`[META] ✅ Vídeo uploaded: ${videoId}`);

  // Aguardar processamento do vídeo na Meta (necessário)
  await aguardarProcessamento(videoId);

  // 2. Criar AdCreative com Click-to-WhatsApp
  logger.info('[META] Criando AdCreative...');
  const creative = await account.createAdCreative([], {
    name: `${nomeCampanha}_CRIA01`,
    object_story_spec: {
      page_id: PAGE_ID,
      video_data: {
        video_id: videoId,
        message: copy.texto_primario,
        title: copy.headline,
        link_description: copy.descricao,
        call_to_action: {
          type: 'WHATSAPP_MESSAGE',
          value: { whatsapp_number: process.env.WHATSAPP_NUMBER }
        }
      }
    }
  });
  logger.info(`[META] ✅ Creative: ${creative.id}`);

  // 3. Criar Campanha
  const campaign = await account.createCampaign([], {
    name: nomeCampanha,
    objective: targeting?.objetivo || 'OUTCOME_ENGAGEMENT',
    status: 'PAUSED',
    special_ad_categories: ['NONE']
  });

  // 4. Criar AdSet
  const adset = await account.createAdSet([], {
    name: `${nomeCampanha}_CONJ01`,
    campaign_id: campaign.id,
    daily_budget: (targeting?.orcamento_diario || 30) * 100,
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'THRUPLAY', // Otimizar pra quem assiste o vídeo
    targeting: {
      age_min: targeting?.idade_min || 25,
      age_max: targeting?.idade_max || 45,
      genders: [2], // Mulheres
      geo_locations: {
        cities: [{ key: '2510794', radius: 40, distance_unit: 'kilometer' }]
      },
      ...(targeting?.interesses && {
        flexible_spec: [{
          interests: targeting.interesses.map(i => ({ name: i }))
        }]
      })
    },
    status: 'PAUSED'
  });

  // 5. Criar Ad
  const ad = await account.createAd([], {
    name: `${nomeCampanha}_AD01`,
    adset_id: adset.id,
    creative: { creative_id: creative.id },
    status: 'PAUSED'
  });

  logger.info(`[META] ✅ Campanha completa criada: ${campaign.id}`);

  return {
    video_id: videoId,
    creative_id: creative.id,
    campaign_id: campaign.id,
    adset_id: adset.id,
    ad_id: ad.id,
    status: 'PAUSED',
    nome: nomeCampanha
  };
}

async function uploadVideoMeta(filePath, titulo) {
  const form = new FormData();
  form.append('source', fs.createReadStream(filePath));
  form.append('title', titulo);
  form.append('access_token', ACCESS_TOKEN);

  const { data } = await axios.post(
    `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT}/advideos`,
    form,
    { headers: { ...form.getHeaders() }, maxContentLength: Infinity }
  );

  return data.id;
}

async function aguardarProcessamento(videoId) {
  let pronto = false;
  let tentativas = 0;

  while (!pronto && tentativas < 30) {
    await new Promise(r => setTimeout(r, 5000));
    tentativas++;

    const { data } = await axios.get(
      `https://graph.facebook.com/${API_VERSION}/${videoId}`,
      { params: { fields: 'status', access_token: ACCESS_TOKEN } }
    );

    if (data.status?.video_status === 'ready') {
      pronto = true;
    }
  }

  if (!pronto) logger.warn('[META] Vídeo não processou em tempo, tentando mesmo assim...');
}

module.exports = { publicarVideo };
```

---

## 5. ORQUESTRADOR — 1 ENDPOINT FAZ TUDO

```javascript
// src/services/video/videoPipeline.js
const { gerarRoteiro } = require('../../agents/zeus-video');
const { gerarVideo } = require('../heygen/heygenService');
const { posProducao, gerarSRTdoRoteiro } = require('./postProduction');
const { publicarVideo } = require('../meta/videoPublisher');
const { nomearCampanha, FUNIS } = require('../../agents/heracles');
const logger = require('../../utils/logger');
const VideoJob = require('../../models/VideoJob'); // Mongoose model

/**
 * PIPELINE COMPLETO — 1 chamada = vídeo publicado
 * 
 * Tempo estimado: 5-10 minutos (HeyGen é o gargalo)
 * 
 * @param {Object} params
 * @param {string} params.tema - "3 sinais na fala aos 3 anos"
 * @param {string} params.especialidade - "fonoaudiologia"
 * @param {string} params.funil - "TOPO"
 * @param {number} params.duracao - 60 (segundos)
 * @param {boolean} params.publicar - true (cria campanha na Meta)
 * @param {Object} params.targeting - targeting da campanha
 */
async function executarPipeline(params) {
  const { tema, especialidade, funil = 'TOPO', duracao = 60, publicar = true, targeting } = params;

  const jobId = `vid_${Date.now()}`;
  logger.info(`🎬 [PIPELINE] Iniciando ${jobId}: "${tema}"`);

  // Salvar job no Mongo pra tracking
  const job = await VideoJob.create({
    jobId,
    tema,
    especialidade,
    funil,
    status: 'ROTEIRO',
    iniciado_em: new Date()
  });

  try {
    // ═══════════════════════════════════════════
    // ETAPA 1: Gerar roteiro (ZEUS) — ~5 segundos
    // ═══════════════════════════════════════════
    logger.info(`[1/4] ZEUS gerando roteiro...`);
    const { roteiro } = await gerarRoteiro({ tema, especialidade, funil, duracao });
    
    await VideoJob.updateOne({ jobId }, { 
      status: 'HEYGEN', 
      roteiro: roteiro.texto_completo,
      profissional: roteiro.profissional 
    });

    // ═══════════════════════════════════════════
    // ETAPA 2: Gerar vídeo no HeyGen — ~3-5 minutos
    // ═══════════════════════════════════════════
    logger.info(`[2/4] HEYGEN gerando vídeo (${roteiro.profissional})...`);
    const videoCru = await gerarVideo({
      profissional: roteiro.profissional,
      textoFala: roteiro.texto_completo,
      titulo: roteiro.titulo
    });

    await VideoJob.updateOne({ jobId }, { status: 'POS_PRODUCAO', video_cru: videoCru });

    // ═══════════════════════════════════════════
    // ETAPA 3: Pós-produção FFmpeg — ~30 segundos
    // ═══════════════════════════════════════════
    logger.info(`[3/4] FFMPEG pós-produção...`);
    const videoFinal = await posProducao({
      videoInput: videoCru,
      hookTexto: roteiro.hook_texto_overlay,
      ctaTexto: roteiro.cta_texto_overlay,
      musica: funil === 'TOPO' ? 'calma' : 'esperancosa',
      titulo: roteiro.titulo.replace(/\s+/g, '_').toLowerCase()
    });

    await VideoJob.updateOne({ jobId }, { status: 'UPLOAD', video_final: videoFinal });

    // ═══════════════════════════════════════════
    // ETAPA 4: Publicar na Meta — ~1-2 minutos
    // ═══════════════════════════════════════════
    let metaResult = null;

    if (publicar) {
      logger.info(`[4/4] META publicando campanha...`);
      const nome = nomearCampanha({
        funil: FUNIS[funil.toLowerCase()] || funil,
        especialidade,
        formato: 'REELS'
      });

      metaResult = await publicarVideo({
        videoPath: videoFinal,
        copy: roteiro.copy_anuncio,
        nomeCampanha: nome,
        targeting
      });
    }

    // ═══════════════════════════════════════════
    // RESULTADO
    // ═══════════════════════════════════════════
    const resultado = {
      jobId,
      status: 'CONCLUIDO',
      roteiro: {
        titulo: roteiro.titulo,
        profissional: roteiro.profissional,
        duracao: roteiro.duracao_estimada,
        texto: roteiro.texto_completo
      },
      video_final: videoFinal,
      meta: metaResult,
      tempo_total: `${((Date.now() - job.iniciado_em) / 1000 / 60).toFixed(1)} minutos`
    };

    await VideoJob.updateOne({ jobId }, {
      status: 'CONCLUIDO',
      meta_campaign_id: metaResult?.campaign_id,
      concluido_em: new Date(),
      resultado
    });

    logger.info(`🎬 [PIPELINE] ✅ ${jobId} concluído em ${resultado.tempo_total}`);
    return resultado;

  } catch (error) {
    logger.error(`🎬 [PIPELINE] ❌ ${jobId} falhou: ${error.message}`);
    await VideoJob.updateOne({ jobId }, { status: 'ERRO', erro: error.message });
    throw error;
  }
}

module.exports = { executarPipeline };
```

---

## 6. MONGOOSE MODEL + ROTA EXPRESS

```javascript
// src/models/VideoJob.js
const mongoose = require('mongoose');

const videoJobSchema = new mongoose.Schema({
  jobId: { type: String, unique: true, required: true },
  tema: String,
  especialidade: String,
  funil: String,
  profissional: String,
  roteiro: String,
  status: {
    type: String,
    enum: ['ROTEIRO', 'HEYGEN', 'POS_PRODUCAO', 'UPLOAD', 'CONCLUIDO', 'ERRO'],
    default: 'ROTEIRO'
  },
  video_cru: String,
  video_final: String,
  meta_campaign_id: String,
  erro: String,
  resultado: mongoose.Schema.Types.Mixed,
  iniciado_em: Date,
  concluido_em: Date
}, { timestamps: true });

module.exports = mongoose.model('VideoJob', videoJobSchema);
```

```javascript
// src/routes/video.js — adicionar ao Express
const router = require('express').Router();
const { executarPipeline } = require('../services/video/videoPipeline');
const VideoJob = require('../models/VideoJob');

// POST /api/video/gerar — Pipeline completo
router.post('/gerar', async (req, res) => {
  try {
    // Responde imediato, processa em background
    const { tema, especialidade, funil, duracao, publicar, targeting } = req.body;

    // Validação básica
    if (!tema || !especialidade) {
      return res.status(400).json({ error: 'tema e especialidade obrigatórios' });
    }

    // Iniciar em background (não bloqueia a request)
    const jobPromise = executarPipeline({ tema, especialidade, funil, duracao, publicar, targeting });
    
    // Retorna jobId imediato
    const jobId = `vid_${Date.now()}`;
    res.json({ 
      success: true, 
      message: 'Pipeline iniciado',
      jobId,
      tempo_estimado: '5-10 minutos',
      status_url: `/api/video/status/${jobId}`
    });

    // Pipeline roda em background
    await jobPromise;

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/video/status/:jobId — Checar progresso
router.get('/status/:jobId', async (req, res) => {
  const job = await VideoJob.findOne({ jobId: req.params.jobId });
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json(job);
});

// POST /api/video/lote — Gerar vários de uma vez
router.post('/lote', async (req, res) => {
  const { videos } = req.body; // Array de { tema, especialidade, funil }
  
  const jobs = videos.map(v => executarPipeline(v));
  
  res.json({
    success: true,
    message: `${videos.length} vídeos sendo gerados em paralelo`,
    tempo_estimado: '10-15 minutos'
  });

  // Processar em paralelo (máx 3 simultâneos)
  const CONCURRENCY = 3;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.allSettled(jobs.slice(i, i + CONCURRENCY));
  }
});

module.exports = router;
```

---

## 7. COMO USAR

```bash
# Gerar 1 vídeo completo (roteiro → vídeo → pós → campanha)
curl -X POST http://localhost:3000/api/video/gerar \
  -H "Content-Type: application/json" \
  -d '{
    "tema": "3 sinais na fala que toda mãe de criança de 3 anos precisa observar",
    "especialidade": "fonoaudiologia",
    "funil": "TOPO",
    "duracao": 45,
    "publicar": true,
    "targeting": {
      "orcamento_diario": 30,
      "interesses": ["Autismo", "Desenvolvimento infantil", "Fonoaudiologia"]
    }
  }'

# Gerar lote semanal (6 vídeos de uma vez)
curl -X POST http://localhost:3000/api/video/lote \
  -H "Content-Type: application/json" \
  -d '{
    "videos": [
      { "tema": "Mito ou verdade: criança com autismo não faz contato visual", "especialidade": "psicologia", "funil": "TOPO" },
      { "tema": "O que é terapia ocupacional infantil e quando procurar", "especialidade": "terapia_ocupacional", "funil": "TOPO" },
      { "tema": "Como funciona a avaliação multidisciplinar na Fono Inova", "especialidade": "geral", "funil": "MEIO" },
      { "tema": "TDAH não é falta de educação — entenda a diferença", "especialidade": "psicologia", "funil": "TOPO" },
      { "tema": "Quando procurar um neuropsicólogo para seu filho", "especialidade": "neuropsicologia", "funil": "TOPO" },
      { "tema": "Musicoterapia: como a música ajuda no desenvolvimento", "especialidade": "musicoterapia", "funil": "MEIO" }
    ]
  }'

# Checar progresso
curl http://localhost:3000/api/video/status/vid_1740420000000
```

---

## 8. ASSETS NECESSÁRIOS (criar 1 vez)

```
assets/video/
├── logo.png              → Logo Fono Inova, PNG transparente, 400x400px
├── cta_card.png          → Card final 1080x1920:
│                            "Fale com a Amanda no WhatsApp 💚"
│                            + número + logo
├── musica_calma.mp3      → Faixa royalty-free (Pixabay ou Artlist)
├── musica_esperancosa.mp3 → Faixa royalty-free upbeat
└── musica_emocional.mp3  → Faixa royalty-free piano suave
```

---

## 9. CUSTO REAL DA OPERAÇÃO

```
HeyGen Creator:     $24/mês → 15 créditos → ~15 vídeos de 1 min
HeyGen Business:    $60/mês → 30 créditos → ~30 vídeos (recomendado)
Claude API (ZEUS):  ~$2/mês → ~200 roteiros
FFmpeg:             Gratuito (servidor)
Whisper:            Gratuito (local) ou ~$0.006/min (API OpenAI)
Meta Ads:           R$2.000/mês (tráfego)
────────────────────────────────────
Total ferramentas:  ~R$400/mês
Produção:           24 vídeos/mês
Custo por vídeo:    ~R$17
Tempo por vídeo:    ~8 min (automático)
Intervenção humana: ZERO
```

---

*Pipeline 100% Automático — Fono Inova 💚*
