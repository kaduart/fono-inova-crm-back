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

📍 Anápolis - GO | 📲 (62) 99337-7726
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

📍 Anápolis - GO | 📲 (62) 99337-7726
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

📍 Anápolis - GO | 📲 (62) 99337-7726
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
📍 Anápolis - GO | 📲 (62) 99337-7726
