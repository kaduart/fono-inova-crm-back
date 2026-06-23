# 🤖 Configuração de Posts Automáticos - GMB

> **Sistema de geração automática de posts para Google Meu Negócio e Redes Sociais**

---

## 📋 Como Funciona

O sistema cria posts automaticamente todos os dias às **7h da manhã**, agendando para os horários estratégicos:
- 08:00 - 🌅 Início do dia
- 12:30 - 🌞 Almoço
- 15:00 - ☕ Tarde  
- 19:00 - 🌆 Final do dia

---

## 🆕 Novas LPs Integradas para Geração Automática

### ✅ Ativas (em produção)

| LP | Categoria | Prioridade | Horário Sugerido |
|-----|-----------|------------|------------------|
| `/fala-tardia` | fonoaudiologia | 🔴 10 | 08:00 |
| `/avaliacao-autismo-infantil` | autismo | 🔴 10 | 12:30 |
| `/dislexia-infantil` | aprendizagem | 🔴 10 | 15:00 |
| `/tdah-infantil` | neuropsicologia | 🔴 10 | 19:00 |
| `/dificuldade-escolar` | aprendizagem | 🟡 9 | 12:30 |
| `/freio-lingual` | freio_lingual | 🟡 8 | 15:00 |
| `/fonoaudiologia-adulto` | fonoaudiologia | 🟢 6 | 19:00 |

### 🚧 Em Construção (futuras)

| LP | Categoria | Previsão |
|-----|-----------|----------|
| `/sindrome-de-down` | desenvolvimento | Q2 2024 |
| `/prematuridade-desenvolvimento` | desenvolvimento | Q2 2024 |
| `/seletividade-alimentar` | terapia_ocupacional | Q2 2024 |

---

## 🎯 Fluxo de Geração Automática

```
7h da manhã (Cron)
    ↓
getLandingPageOfTheDay() → Retorna 1 LP de cada categoria
    ↓
Para cada LP:
  - Gera conteúdo com SEO otimizado
  - Busca/gera imagem (ImageBank → Fal.ai → Freepik)
  - Cria post no banco (status: scheduled)
  - Agenda para horário estratégico
    ↓
Posts disponíveis para aprovação no dashboard
```

---

## 📝 Templates de Conteúdo Automático

### Fala Tardia
```
🗣️ Criança de 2 anos não fala? [HOOK]

Seu filho tem 2 anos e ainda não diz pelo menos 20 palavras? 
Não junta duas palavras? 

Isso pode ser fala tardia — e quanto antes a avaliação, melhores os resultados.

✨ Na Fono Inova avaliamos o desenvolvimento da linguagem de forma completa.

⚠️ Cada mês sem intervenção é um mês de atraso.

💚 Agende uma avaliação gratuita: [LINK]

📍 Anápolis - GO | 📲 (62) 99201-3573
```

### Dislexia
```
🔤 Seu filho confunde letras? Troca b por d? [HOOK]

A dislexia é mais comum do que você imagina — e tem TRATAMENTO!

📚 Sinais:
• Troca letras parecidas (b/d, p/q)
• Leitura espelhada
• Leitura lenta e cansativa

⏰ Intervenção antes dos 9 anos tem 90% de sucesso!

✅ Método fônico estruturado na Fono Inova.

💚 [CTA]

📍 Anápolis - GO | 📲 (62) 99201-3573
```

### TDAH
```
⚡ Seu filho é MUITO inquieto? Não consegue parar? [HOOK]

🎯 3 pilares do TDAH:
1️⃣ Desatenção 
2️⃣ Hiperatividade
3️⃣ Impulsividade

⚠️ Sem tratamento: baixo rendimento escolar, baixa autoestima.

✅ Avaliação neuropsicológica completa na Fono Inova.

💚 [CTA]

📍 Anápolis - GO | 📲 (62) 99201-3573
```

---

## 🖼️ Geração de Imagens

### Ordem de Prioridade:
1. **ImageBank** (reutilização) - Busca imagens já usadas < 3x
2. **Fal.ai FLUX** - Geração IA (melhor qualidade)
3. **Freepik AI** - Fallback
4. **Pollinations** - Último recurso (gratuito)
5. **Unsplash** - Imagens reais genéricas

### Prompts por Especialidade:
- Configurados em `generateImagePromptFromContent()` no gmbService.js
- Cada especialidade tem ambiente e interação específicos

---

## ⚙️ Comandos Úteis

### Executar manualmente (teste)
```javascript
import { runLandingPageDailyPostsNow } from './crons/landingPageDailyPost.js';
await runLandingPageDailyPostsNow();
```

### Ver status do cron
```javascript
import { getLandingPageCronStatus } from './crons/landingPageDailyPost.js';
getLandingPageCronStatus();
```

### Forçar post para LP específica
```javascript
import * as landingPageService from './services/landingPageService.js';
import { createGmbPostForLandingPage } from './crons/landingPageDailyPost.js';

const lp = await landingPageService.suggestForPost('dislexia-infantil', 1);
await createGmbPostForLandingPage(lp[0], new Date());
```

---

## 📊 Monitoramento

### Logs Importantes:
```
🔄 [LandingPage Cron] Iniciando criação de posts diários...
📝 Criando post para {categoria}: LP: {slug}
🖼️ [LP {slug}] Processando imagem...
✅ [LP {slug}] Imagem OK: {provider}
✅ Post criado para LP: {slug}
📊 [LandingPage Cron] Resumo: ✅ Sucesso: X | ❌ Falhas: Y
```

### Métricas de Acompanhamento:
- Taxa de sucesso na geração de imagens
- LPs mais usadas em posts
- Horários com maior engajamento
- Conversão de posts automáticos

---

## 🔧 Configuração de Ambiente

### Variáveis necessárias (.env):
```env
# OpenAI - Geração de conteúdo
OPENAI_API_KEY=sk-...

# Cloudinary - Armazenamento de imagens
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# Fal.ai - Geração de imagens (opcional, mas recomendado)
FAL_API_KEY=...

# Freepik - Fallback de imagens (opcional)
FREEPIK_API_KEY=...

# HuggingFace - Fallback gratuito (opcional)
HUGGINGFACE_API_KEY=...
```

---

## 🚀 Próximos Passos (Roadmap)

- [ ] Implementar geração de Reels/Vídeos automáticos
- [ ] Adicionar integração direta com Instagram API
- [ ] Criar sistema de A/B testing para hooks
- [ ] Implementar análise de sentimento dos comentários
- [ ] Gerar posts responsivos baseados em tendências

---

**Fono Inova - Centro de Desenvolvimento Infantil**  
📍 Anápolis - GO | 📲 (62) 99201-3573


---

# 📅 Calendário Temático GMB — 30 Dias

## 🎯 Objetivo

Reforçar a autoridade tópica da clínica publicando posts diários alinhados aos clusters de conteúdo do site:
- Fonoaudiologia
- Neuropediatria
- Psicologia Infantil
- Neuropsicologia
- Hub Multidisciplinar

## ⏰ Agendamento

O calendário temático é executado diariamente às **07:00** pelo cron principal (`back/jobs/gmbScheduledTasks.js`).

Cada dia do mês (1 a 30) tem um tema específico, URL de destino e funil definidos. O dia 31 reutiliza o tema do dia 30.

## 📁 Arquivos

- `back/services/gmbCalendarService.js` — calendário e lógica de criação
- `back/jobs/gmbScheduledTasks.js` — cron diário às 07:00
- `back/controllers/gmbController.js` — endpoints manuais
- `back/routes/gmb.routes.js` — rotas da API

## 🔗 Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/gmb/calendar` | Lista os 30 posts do calendário |
| POST | `/api/gmb/admin/trigger-calendar-today` | Cria o post do dia manualmente |
| POST | `/api/gmb/admin/trigger-calendar-upcoming` | Cria posts dos próximos dias (body: `{ dias: 7 }`) |

## 🗓️ Estrutura do Calendário

Cada item do calendário contém:
- `dia` — dia do mês (1 a 30)
- `tema` — assunto do post
- `especialidadeId` — especialidade vinculada ao gmbService
- `url` — link de destino no site
- `intencao` — intenção de busca alvo
- `angulo` — ângulo emocional (medo, duvida, educacao, etc.)
- `funil` — top, middle ou bottom
- `tipo` — dor, decisao ou autoridade

## 🧩 Exemplos de Temas

- Dia 1: "Criança de 2 anos não fala: quando procurar ajuda?"
- Dia 5: "Como funciona a avaliação multidisciplinar infantil?"
- Dia 15: "Fonoaudiologia infantil em Anápolis"
- Dia 30: "Clínica multidisciplinar infantil em Anápolis"

## 🚀 Execução Manual

```javascript
import * as gmbCalendarService from './services/gmbCalendarService.js';

// Criar post de hoje
await gmbCalendarService.createTodaysCalendarPost();

// Criar posts dos próximos 7 dias
await gmbCalendarService.createCalendarPostsForUpcomingDays(7);

// Ver calendário completo
console.log(gmbCalendarService.CALENDARIO_GMB_30_DIAS);
```

## 🛡️ Idempotência e Lifecycle

### Idempotência

O calendário temático é **idempotente por data**:

1. **Chave única `date` (YYYY-MM-DD)** no modelo `GmbCalendarRun` impede execuções duplicadas do mesmo dia
2. **Segunda camada de proteção** verifica se já existe um post com tag `calendario-tematico` criado hoje
3. Se o cron rodar 2x (deploy, retry, crash recovery), a segunda execução é ignorada

### Lifecycle do Post

```
pending    → running     → scheduled   → published
              (execução)   (gerado)      (no GMB)
                ↓
              failed
```

- `running` — execução do cron iniciada
- `scheduled` — post gerado e agendado para publicação
- `published` — confirmado pelo callback do Make
- `failed` — erro na geração, registrado no `GmbCalendarRun`

### Logs e Auditoria

Toda execução é salva em `GmbCalendarRun`:

| Campo | Descrição |
|-------|-----------|
| `date` | Data da execução (YYYY-MM-DD) |
| `calendarDay` | Dia do calendário utilizado (1-30) |
| `status` | running / success / failed / skipped |
| `postsCreated` | Posts criados na execução |
| `durationMs` | Tempo total de geração |
| `error` | Erro, se houver |
| `payload` | Tema, URL, funil e ângulo utilizados |
| `triggeredBy` | cron ou manual |

### Endpoints de Observabilidade

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/gmb/calendar/runs` | Histórico de execuções do calendário |

## ✅ Benefícios

- **Notoriedade diária**: post todo dia no GMB
- **Autoridade tópica**: reforça todos os clusters da clínica
- **SEO local**: posts linkam para URLs existentes e otimizadas
- **Conversão**: equilíbrio entre conteúdo educativo e posts de decisão
- **Rastreamento**: posts são tagueados como `calendario-tematico` para métricas
- **Observabilidade**: execuções logadas com status, duração e erros
- **Resiliência**: idempotente por data, safe para retry e crash recovery


---

# 🧪 A/B Engine do Calendário GMB

## 🎯 Conceito

Cada tema do calendário gera **2 variações de copy**:

- **A (educativo / autoridade)** — foca em informação, esclarecimento e SEO
- **B (emocional / conversão)** — foca na dor do pai/mãe e CTA para WhatsApp

## 🤖 Lógica de Seleção

1. **Fase 1 — Exploração**: round-robin (alterna A/B) até ter pelo menos 2 amostras de cada
2. **Fase 2 — Exploração guiada**: favorece a variante com mais cliques no WhatsApp
3. **Fase 3 — Otimização**: mantém 80% da vencedora, 20% de exploração

> Vencedor é sempre por **tema**, nunca global.

## 📁 Arquivos

- `back/services/gmbABEngine.js` — motor de variações e seleção
- `back/models/GmbABTest.js` — schema de testes A/B
- `back/services/gmbCalendarService.js` — integra A/B na criação diária
- `back/controllers/gmbController.js` — endpoints de métricas
- `back/routes/gmb.routes.js` — rotas da API

## 🔗 Endpoints A/B

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/gmb/ab-tests` | Lista todos os testes A/B |
| GET | `/api/gmb/ab-tests/performance` | Performance por tema e vencedora |
| POST | `/api/gmb/ab-tests/preview-variant` | Preview de variante A/B (body: `{ tema, variant }`) |
| POST | `/api/gmb/ab-tests/:postId/view` | Registra visualização |
| POST | `/api/gmb/ab-tests/:postId/whatsapp-click` | Registra clique no WhatsApp |
| POST | `/api/gmb/ab-tests/:postId/lead` | Registra lead gerado |

## 📊 Métrica de Vitória

**WhatsApp lead** é a métrica principal.

Proxy aceitável enquanto não houver tracking perfeito:
- `whatsapp-click` — clique no link do WhatsApp no post

Métricas secundárias:
- `views` — visualizações do post
- `leads` — conversões confirmadas

## 🏷️ Rastreamento no Post

Cada post do calendário recebe metadados:

```js
{
  abVariant: 'A' | 'B',
  abLabel: 'educativo' | 'emocional-conversao',
  abThemeKey: 'crianca-de-2-anos-nao-fala',
  abTestId: ObjectId
}
```

E tags:
- `calendario-tematico`
- `variant-A` ou `variant-B`

## 💻 Tracking no Front CRM

Os previews do GMB (`GmbDashboard` e `MarketingDashboard`) registram métricas A/B automaticamente:

- **View**: quando o modal de preview abre → `POST /api/gmb/ab-tests/:postId/view`
- **WhatsApp click**: quando o botão "Falar no WhatsApp" do preview é clicado → `POST /api/gmb/ab-tests/:postId/whatsapp-click`
- **Lead**: ainda pode ser registrado manualmente pela API (`POST /api/gmb/ab-tests/:postId/lead`)

Arquivos envolvidos no front:
- `front/src/services/gmbAbTracking.ts` — centraliza as chamadas de tracking
- `front/src/components/Dashboard/GmbDashboard.tsx` — preview com tracking
- `front/src/components/Dashboard/MarketingDashboard.tsx` — preview unificado com tracking

O serviço `gmbAbTracking.ts`:
- Exibe `abVariant` e `abTestId` no console em dev
- Evita duplicar views no mesmo post dentro da mesma sessão de página
- Abre o WhatsApp Web/App e dispara o tracking em paralelo
- Trata erros silenciosamente para não quebrar a UX

## 🚀 Benefícios

- **Conversão real**: otimiza para WhatsApp, não só para clique
- **Aprendizado por tema**: cada tema tem seu próprio vencedor
- **Sem complexidade extra**: reaproveita todo o motor existente
- **Evolução gradual**: começa com round-robin, converge para vencedora
