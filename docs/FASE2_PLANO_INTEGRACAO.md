# FASE 2: PLANO DE INTEGRAÇÃO DO PIPELINE DE VÍDEO

> Data: 2026-02-24  
> Objetivo: Integrar o novo pipeline de vídeo 100% automático sem quebrar o que já funciona

---

## 1. VISÃO GERAL DA INTEGRAÇÃO

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                    PIPELINE DE VÍDEO INTEGRADO — FASE 2                            │
└─────────────────────────────────────────────────────────────────────────────────────┘

NOVO ENDPOINT: POST /api/video/gerar
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  ETAPA 1: GERAR ROTEIRO (Estender gmbService.js)                                   │
│  ─────────────────────────────────────────────────────                              │
│  • Reaproveitar: OpenAI/GPT-4o-mini                                                 │
│  • Novo: Prompt ZEUS (estruturado para vídeo)                                       │
│  • Output: JSON com texto_completo, hook, CTA, copy_anuncio                         │
└─────────────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  ETAPA 2: GERAR VÍDEO HEYGEN (Novo: heygenService.js)                              │
│  ─────────────────────────────────────────────────────                              │
│  • Múltiplos avatares (fono_ana, psico_bia, to_carla, ...)                          │
│  • Polling com timeout de 10 minutos                                                │
│  • Download MP4 para servidor                                                       │
└─────────────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  ETAPA 3: PÓS-PRODUÇÃO FFMPEG (Novo: postProduction.js)                            │
│  ─────────────────────────────────────────────────────                              │
│  • Legendas automáticas (Whisper ou SRT do roteiro)                                 │
│  • Logo overlay (cantos superior)                                                   │
│  • Card CTA final (últimos 5s)                                                      │
│  • Música de fundo (volume 8%)                                                      │
│  • Output: MP4 final 1080x1920                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  ETAPA 4: UPLOAD META ADS (Novo: metaVideoPublisher.js) — OPCIONAL                 │
│  ─────────────────────────────────────────────────────                              │
│  • Upload vídeo como AdVideo                                                        │
│  • Criar AdCreative (Click-to-WhatsApp)                                             │
│  • Criar Campaign + AdSet + Ad (PAUSED)                                             │
└─────────────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  ETAPA 5: SALVAR E NOTIFICAR                                                       │
│  ─────────────────────────────────────────────────────                              │
│  • Salvar VideoJob no MongoDB                                                       │
│  • Emitir Socket.IO para frontend                                                   │
│  • Retornar resultado                                                               │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. ONDE ENCAIXAR CADA ETAPA

### 2.1 Estrutura de Arquivos Proposta

```
back/
├── services/
│   ├── marketingService.js          # ✅ EXISTENTE (estender)
│   ├── gmbService.js                # ✅ EXISTENTE (estender)
│   ├── video/
│   │   ├── heygenService.js         # 🆕 NOVO - Integração HeyGen
│   │   ├── postProduction.js        # 🆕 NOVO - FFmpeg pós-produção
│   │   └── videoPipeline.js         # 🆕 NOVO - Orquestrador principal
│   └── meta/
│       └── videoPublisher.js        # 🆕 NOVO - Meta Ads API (futuro)
├── models/
│   ├── Video.js                     # ✅ EXISTENTE (estender)
│   └── VideoJob.js                  # 🆕 NOVO - Job tracking (opcional)
├── routes/
│   ├── marketing.routes.js          # ✅ EXISTENTE (adicionar rotas)
│   └── video.routes.js              # ✅ EXISTENTE (estender)
├── config/
│   └── bullConfig.js                # ✅ EXISTENTE (adicionar fila)
├── assets/
│   └── video/                       # 🆕 NOVO
│       ├── logo.png                 # Logo Fono Inova (transparente)
│       ├── cta_card.png             # Card final CTA
│       ├── musica_calma.mp3         # Trilha sonora 1
│       └── musica_esperancosa.mp3   # Trilha sonora 2
└── tmp/
    └── videos/                      # 🆕 NOVO (temporário)
        ├── raw/                     # Vídeos crus do HeyGen
        └── final/                   # Vídeos finais
```

### 2.2 Mapeamento de Responsabilidades

| Componente | Responsabilidade | Arquivo |
|------------|------------------|---------|
| **Roteiro** | Gerar texto completo, hook, CTA, copy_anuncio | Estender `gmbService.js` ou criar `zeusVideoPrompt.js` |
| **HeyGen** | Criar vídeo talking head, polling, download | `services/video/heygenService.js` |
| **FFmpeg** | Legendas, logo, CTA card, música | `services/video/postProduction.js` |
| **Orquestrador** | Coordenar etapas, emitir eventos, salvar | `services/video/videoPipeline.js` |
| **Queue** | Processar em background (BullMQ) | `config/bullConfig.js` (adicionar) |
| **Meta Ads** | Upload, criar campanha | `services/meta/videoPublisher.js` (futuro) |

---

## 3. COMO REAPROVEITAR O GERADOR DE COPY

### 3.1 Estratégia: Extensão do Serviço Existente

**Opção A: Estender `gmbService.js` (Recomendada)**

```javascript
// back/services/gmbService.js

/**
 * 🎬 GERA ROTEIRO DE VÍDEO (ZEUS v2)
 * Estende a função generatePostForEspecialidade para vídeo
 */
export async function generateVideoRoteiro({ tema, especialidadeId, funil = 'TOPO', duracao = 60 }) {
  const especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
  
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

ESPECIALIDADE: ${especialidade.nome}
TEMA: ${tema}
FUNIL: ${funil}
DURAÇÃO: ${duracao}s

Retorne APENAS JSON:
{
  "roteiro": {
    "titulo": "string (pra nomenclatura do arquivo)",
    "profissional": "${especialidadeId}",
    "duracao_estimada": ${duracao},
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

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Você é um roteirista especialista em vídeos para clínicas de saúde infantil.' },
      { role: 'user', content: ZEUS_VIDEO_PROMPT }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7
  });

  return JSON.parse(completion.choices[0].message.content);
}
```

### 3.2 Diferença: Copy de Post vs Roteiro de Vídeo

| Aspecto | Post GMB/Insta | Roteiro de Vídeo |
|---------|----------------|------------------|
| **Formato** | Texto livre | JSON estruturado |
| **Tom** | Escrito formal | Fala conversacional |
| **Saída** | 1 campo `content` | 8+ campos (texto, hook, CTA, copy_anuncio...) |
| **Compliance** | Básico | Estrito (saúde) |
| **Estrutura** | Livre | Por segundos [0-5s], [5-20s]... |
| **Modelo** | GPT-3.5-turbo | GPT-4o-mini |

---

## 4. COMO REAPROVEITAR O GERADOR DE IMAGEM

### 4.1 Thumbnail do Vídeo

Reutilizar `generateImageForEspecialidade()` para gerar thumbnail:

```javascript
// Em videoPipeline.js
import { generateImageForEspecialidade } from '../gmbService.js';

// Gerar thumbnail baseado no tema do vídeo
const thumbnailUrl = await generateImageForEspecialidade(
  especialidade, 
  roteiro.hook_texto_overlay  // Usar hook como briefing
);
```

### 4.2 Card CTA Final

Criar asset estático ou gerar dinâmico:

```javascript
// Opção 1: Asset estático (recomendado)
// assets/video/cta_card.png — já criado no Canva/Figma

// Opção 2: Gerar dinamicamente com Canvas/Sharp (futuro)
// Criar imagem 1080x1920 com texto dinâmico
```

---

## 5. NOVAS DEPENDÊNCIAS

### 5.1 Verificar Instalação

Todas as dependências principais **JÁ ESTÃO INSTALADAS**:

```bash
# Verificar no package.json
"ffmpeg-static": "^5.3.0"       # ✅ JÁ TEM
"fluent-ffmpeg": "^2.1.3"       # ✅ JÁ TEM
"openai": "^6.5.0"              # ✅ JÁ TEM (Whisper)
"axios": "^1.x"                 # ✅ JÁ TEM (via node-fetch)
"form-data": "^4.0.5"           # ✅ JÁ TEM
```

### 5.2 Dependências Opcionais (Whisper local)

```bash
# Opção 1: Whisper via OpenAI API (recomendado - já funciona)
# Usar: openai.audio.transcriptions.create({ model: 'whisper-1' })

# Opção 2: Whisper local (mais rápido, mas precisa instalar)
# NÃO RECOMENDADO — adiciona complexidade
```

### 5.3 FFmpeg no Servidor

```bash
# Verificar se FFmpeg está instalado
ffmpeg -version

# Se não estiver (Ubuntu/Debian):
sudo apt-get update
sudo apt-get install -y ffmpeg

# Fontes para legendas
sudo apt-get install -y fonts-roboto
```

---

## 6. NOVAS VARIÁVEIS DE AMBIENTE

### 6.1 HeyGen (Múltiplos Profissionais)

Adicionar ao `.env`:

```bash
# HeyGen - Múltiplos avatares (1 por profissional)
HEYGEN_API_KEY=sk_V2_hgu_ksLNZppEOL1_II2TZ79AJxBrcZVDueUYPfmeryHqpmUh

# Fonoaudiologia - Ana
HEYGEN_AVATAR_FONO=Abigail_expressive_2024112501  # ou outro ID
HEYGEN_VOICE_FONO=0130939032d87be594eadc8cc9d39415

# Psicologia - Bia
HEYGEN_AVATAR_PSICO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HEYGEN_VOICE_PSICO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Terapia Ocupacional - Carla
HEYGEN_AVATAR_TO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HEYGEN_VOICE_TO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Fisioterapia - Edu
HEYGEN_AVATAR_FISIO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HEYGEN_VOICE_FISIO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Neuropsicologia - Dani
HEYGEN_AVATAR_NEURO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HEYGEN_VOICE_NEURO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Musicoterapia - Fer
HEYGEN_AVATAR_MUSICO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HEYGEN_VOICE_MUSICO=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Meta Ads (futuro)
META_ACCESS_TOKEN=EAxxxxxxxxxxxxxxxx
META_AD_ACCOUNT_ID=act_xxxxxxxx
META_PAGE_ID=xxxxxxxxxxxxxxxx
META_API_VERSION=v21.0
WHATSAPP_NUMBER=+5562993377726
```

---

## 7. NOVA QUEUE BULLMQ

### 7.1 Adicionar em `config/bullConfig.js`

```javascript
// config/bullConfig.js

// 🎬 NOVO: Fila de geração de vídeos
export const videoGenerationQueue = new Queue("video-generation", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000  // 1 minuto
    },
    removeOnComplete: 50,  // Mantém últimos 50 jobs
    removeOnFail: 20       // Mantém últimos 20 falhos
  }
});

export const videoGenerationEvents = new QueueEvents("video-generation", {
  connection: redisConnection
});
```

### 7.2 Worker para Processamento

```javascript
// workers/video.worker.js (novo arquivo)
import { Worker } from 'bullmq';
import { redisConnection } from '../config/redisConnection.js';
import { executarPipeline } from '../services/video/videoPipeline.js';

const worker = new Worker('video-generation', async (job) => {
  const { videoId, params } = job.data;
  
  console.log(`🎬 [Worker] Processando vídeo ${videoId}`);
  
  return await executarPipeline({
    ...params,
    jobId: videoId
  });
}, {
  connection: redisConnection,
  concurrency: 2  // Máx 2 vídeos simultâneos (HeyGen limitado)
});

worker.on('completed', (job) => {
  console.log(`✅ [Worker] Vídeo ${job.id} concluído`);
});

worker.on('failed', (job, err) => {
  console.error(`❌ [Worker] Vídeo ${job.id} falhou:`, err.message);
});
```

---

## 8. SCHEMA MONGOOSE

### 8.1 Estender Model Video.js Existente

```javascript
// models/Video.js (adicionar campos)

const videoSchema = new mongoose.Schema({
  // ✅ CAMPOS EXISTENTES (manter)
  title: { type: String, required: true },
  roteiro: { type: String, required: true },
  especialidadeId: { type: String, required: true },
  avatarId: { type: String, default: null },
  duration: { type: Number, default: 30, enum: [30, 45, 60] },
  status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'processing' },
  videoUrl: { type: String, default: null },
  thumbnailUrl: { type: String, default: null },
  heygenVideoId: { type: String, default: null },
  provider: { type: String, enum: ['heygen'], default: 'heygen' },
  publishedChannels: [{ type: String, enum: ['instagram', 'facebook', 'gmb'] }],
  publishedAt: { type: Date, default: null },
  errorMessage: { type: String, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  
  // 🆕 NOVOS CAMPOS
  jobId: { type: String, unique: true, sparse: true },  // ID do job BullMQ
  
  // Roteiro estruturado (ZEUS)
  roteiroEstruturado: {
    titulo: String,
    profissional: String,
    duracao_estimada: Number,
    texto_completo: String,
    hook_texto_overlay: String,
    cta_texto_overlay: String,
    hashtags: [String],
    copy_anuncio: {
      texto_primario: String,
      headline: String,
      descricao: String
    }
  },
  
  // Status do pipeline
  pipelineStatus: {
    type: String,
    enum: ['ROTEIRO', 'HEYGEN', 'POS_PRODUCAO', 'UPLOAD', 'CONCLUIDO', 'ERRO'],
    default: 'ROTEIRO'
  },
  
  // URLs dos vídeos
  videoCruUrl: { type: String, default: null },  // HeyGen raw
  videoFinalUrl: { type: String, default: null },  // Após FFmpeg
  
  // Meta Ads (futuro)
  metaCampaignId: { type: String, default: null },
  metaCreativeId: { type: String, default: null },
  
  // Timestamps do pipeline
  tempos: {
    roteiro_em: Date,
    heygen_em: Date,
    pos_producao_em: Date,
    concluido_em: Date
  },
  
  // Progresso (para Socket.IO)
  progresso: {
    etapa: String,
    percentual: { type: Number, default: 0 },
    atualizado_em: { type: Date, default: Date.now }
  }
}, { timestamps: true });
```

---

## 9. ROTAS EXPRESS

### 9.1 Adicionar em `routes/video.routes.js`

```javascript
// routes/video.routes.js

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import * as videoController from '../controllers/videoController.js';
import { videoGenerationQueue } from '../config/bullConfig.js';
import { getIo } from '../config/socket.js';

const router = Router();
router.use(auth);

// ✅ EXISTENTES (manter)
router.get('/', videoController.listVideos);
router.get('/:id/status', videoController.getVideoStatus);
router.post('/:id/publish', videoController.publishVideo);
router.delete('/:id', videoController.deleteVideo);

// 🆕 NOVO: Gerar vídeo completo (pipeline)
router.post('/gerar', async (req, res) => {
  try {
    const { tema, especialidadeId, funil = 'TOPO', duracao = 60, publicar = false } = req.body;
    
    // Validação
    if (!tema || !especialidadeId) {
      return res.status(400).json({ 
        success: false, 
        error: 'tema e especialidadeId são obrigatórios' 
      });
    }
    
    // Criar job ID
    const jobId = `vid_${Date.now()}`;
    
    // Adicionar à fila BullMQ
    const job = await videoGenerationQueue.add('generate-video', {
      videoId: jobId,
      params: { tema, especialidadeId, funil, duracao, publicar }
    }, {
      jobId,
      priority: 1
    });
    
    // Retornar imediatamente
    res.json({
      success: true,
      message: 'Pipeline de vídeo iniciado',
      jobId,
      status: 'ROTEIRO',
      tempo_estimado: '5-10 minutos',
      status_url: `/api/videos/status/${jobId}`
    });
    
  } catch (error) {
    console.error('❌ Erro ao iniciar pipeline:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 NOVO: Status do job
router.get('/status/:jobId', async (req, res) => {
  try {
    const job = await videoGenerationQueue.getJob(req.params.jobId);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job não encontrado' });
    }
    
    const state = await job.getState();
    const progress = job.progress || 0;
    
    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: state,  // 'waiting', 'active', 'completed', 'failed'
        progress,
        result: job.returnvalue,
        failedReason: job.failedReason
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 NOVO: Gerar lote de vídeos
router.post('/lote', async (req, res) => {
  try {
    const { videos } = req.body;  // Array de { tema, especialidadeId, funil }
    
    const jobs = [];
    for (const video of videos) {
      const jobId = `vid_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      jobs.push(
        videoGenerationQueue.add('generate-video', {
          videoId: jobId,
          params: video
        }, { jobId })
      );
    }
    
    await Promise.all(jobs);
    
    res.json({
      success: true,
      message: `${videos.length} vídeos na fila`,
      jobIds: jobs.map(j => j.id),
      tempo_estimado: `${Math.ceil(videos.length * 8)} minutos`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
```

---

## 10. FRONTEND (React)

### 10.1 Componentes Necessários

```
front/src/
├── components/
│   └── marketing/
│       └── video/
│           ├── VideoGenerator.tsx      # 🆕 Form de geração
│           ├── VideoProgress.tsx       # 🆕 Barra de progresso
│           ├── VideoPlayer.tsx         # 🆕 Player com preview
│           └── VideoList.tsx           # 🆕 Lista de vídeos gerados
├── hooks/
│   └── useVideoSocket.ts               # 🆕 Hook Socket.IO
└── services/
    └── videoApi.ts                     # 🆕 API calls
```

### 10.2 Hook Socket.IO (Exemplo)

```typescript
// hooks/useVideoSocket.ts
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

export function useVideoSocket(jobId: string) {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    const socket = io(import.meta.env.VITE_API_URL);
    
    socket.emit('join-video-job', jobId);
    
    socket.on('video-progress', (data) => {
      setProgress(data.percentual);
      setStatus(data.etapa);
    });
    
    socket.on('video-complete', (data) => {
      setResult(data);
      setStatus('CONCLUIDO');
      setProgress(100);
    });
    
    return () => {
      socket.disconnect();
    };
  }, [jobId]);

  return { progress, status, result };
}
```

---

## 11. ORDEM DE IMPLEMENTAÇÃO

### Prioridade 1 — Core (Fazer funcionar)
| # | Tarefa | Arquivo(s) | Estimativa |
|---|--------|------------|------------|
| 1 | Service HeyGen | `services/video/heygenService.js` | 2h |
| 2 | Service FFmpeg | `services/video/postProduction.js` | 3h |
| 3 | Orquestrador | `services/video/videoPipeline.js` | 2h |
| 4 | Estender Video model | `models/Video.js` | 30min |
| 5 | Rota /gerar | `routes/video.routes.js` | 30min |
| 6 | Queue BullMQ | `config/bullConfig.js` + worker | 1h |

**Subtotal Prioridade 1: ~9 horas**

### Prioridade 2 — Integração
| # | Tarefa | Arquivo(s) | Estimativa |
|---|--------|------------|------------|
| 7 | Estender gerador de copy | `services/gmbService.js` | 1h |
| 8 | Socket.IO events | `services/video/videoPipeline.js` | 1h |
| 9 | Assets (logo, CTA, música) | `assets/video/` | 30min |

**Subtotal Prioridade 2: ~2.5 horas**

### Prioridade 3 — Meta Ads (Depois)
| # | Tarefa | Arquivo(s) | Estimativa |
|---|--------|------------|------------|
| 10 | Meta Ads upload | `services/meta/videoPublisher.js` | 3h |
| 11 | Criar campanha | `services/meta/videoPublisher.js` | 2h |

**Subtotal Prioridade 3: ~5 horas**

### Prioridade 4 — Frontend (Depois)
| # | Tarefa | Estimativa |
|---|--------|------------|
| 12 | Componentes React | 4h |
| 13 | Integração API | 2h |

**Subtotal Prioridade 4: ~6 horas**

---

## 12. ESTIMATIVA TOTAL

```
┌─────────────────────────────────────────────────────────┐
│ PRIORIDADE 1 (Core)          │  9h  │  OBRIGATÓRIO    │
│ PRIORIDADE 2 (Integração)    │  2.5h│  RECOMENDADO    │
│ PRIORIDADE 3 (Meta Ads)      │  5h  │  OPCIONAL       │
│ PRIORIDADE 4 (Frontend)      │  6h  │  OPCIONAL       │
├─────────────────────────────────────────────────────────┤
│ TOTAL MÍNIMO                 │  9h  │  Funcional      │
│ TOTAL RECOMENDADO            │ 22.5h│  Completo       │
└─────────────────────────────────────────────────────────┘
```

---

## 13. CHECKLIST DE IMPLEMENTAÇÃO

### Antes de começar
- [ ] Configurar avatares/vozes no HeyGen (todos os profissionais)
- [ ] Instalar FFmpeg no servidor
- [ ] Criar pasta `assets/video/` com logo, CTA card, músicas
- [ ] Adicionar variáveis de ambiente no `.env`

### Durante implementação
- [ ] Seguir padrão de código existente (ES6 modules, async/await)
- [ ] Usar try/catch em todas as operações externas
- [ ] Adicionar logs em cada etapa do pipeline
- [ ] Implementar retry com backoff exponencial
- [ ] Testar cada etapa isoladamente antes de integrar

### Após implementação
- [ ] Testar pipeline completo end-to-end
- [ ] Verificar se vídeos anteriores ainda funcionam
- [ ] Monitorar BullMQ no painel `/admin/queues`
- [ ] Documentar no README

---

*Plano de Integração — Fase 2 do Pipeline de Vídeo Automático 💚*
