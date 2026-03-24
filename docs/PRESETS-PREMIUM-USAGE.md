# 🎬 Presets Premium - Guia de Uso

Sistema de vídeos premium otimizado para alavancar seu negócio com conteúdo de alta conversão.

## 🚀 Presets Disponíveis

| Preset | Objetivo | Ideal Para |
|--------|----------|------------|
| `explosao_viral` | Máxima atenção nos primeiros 5s | Reels, TikTok, Stories |
| `autoridade_inspiradora` | Construir confiança | Feed, Reels, YouTube Shorts |
| `empatia_emocional` | Conexão genuína com pais | Reels, TikTok, Stories |
| `alerta_urgencia` | Ação rápida (agendamento) | Reels, Stories, Ads |
| `erro_correcao` | Gerar salvamentos | Feed, Reels, TikTok |

## 💡 Como Usar

### 1. Via API (Recomendado)

```javascript
// POST /api/videos
{
  "tema": "atraso fala bebe",
  "especialidadeId": "fonoaudiologia",
  "modo": "veo",
  "preset": "explosao_viral",  // 🎬 Aplica configurações premium automaticamente
  "duracao": 30
}
```

### 2. Preset Automático (baseado em hook+tom+intensidade)

Se não especificar `preset`, o sistema recomenda automaticamente:

```javascript
// hookStyle: curiosidade + tone: emotional + intensidade: viral
// → Auto-seleciona: explosao_viral

{
  "tema": "atraso fala",
  "hookStyle": "curiosidade",
  "tone": "emotional",
  "intensidade": "viral"
}
```

### 3. Lista de Presets

```javascript
// GET /api/videos/presets
// Retorna todos os presets disponíveis com configurações
```

## 📋 Configurações de Cada Preset

### 🔥 Explosão Viral
```json
{
  "tts": {
    "voz": "shimmer",
    "velocidade": 1.05,
    "tom": "energetico"
  },
  "musica": {
    "volume": 0.12,
    "fade_in": 1.5,
    "tipo": "upbeat_energetico"
  },
  "veo": {
    "intensidade": "viral",
    "modificadores": "Fast-paced energetic movement, dynamic camera angles, bright vivid colors"
  }
}
```

### 👑 Autoridade Inspiradora
```json
{
  "tts": {
    "voz": "alloy",
    "velocidade": 1.05,
    "tom": "confiante"
  },
  "musica": {
    "volume": 0.12,
    "tipo": "motivacional"
  },
  "veo": {
    "intensidade": "viral",
    "modificadores": "Dynamic camera movement, vibrant colors, professional lighting"
  }
}
```

### 💝 Empatia Emocional
```json
{
  "tts": {
    "voz": "shimmer",
    "velocidade": 1.0,
    "tom": "acolhedor"
  },
  "musica": {
    "volume": 0.10,
    "fade_in": 2.0,
    "tipo": "emocional_suave"
  },
  "veo": {
    "intensidade": "forte",
    "modificadores": "Smooth transitions, warm tones, gentle movements"
  }
}
```

### ⚡ Alerta & Urgência
```json
{
  "tts": {
    "voz": "alloy",
    "velocidade": 1.02,
    "tom": "firme"
  },
  "musica": {
    "volume": 0.10,
    "fade_in": 1.0,
    "tipo": "ritmo_rapido"
  },
  "veo": {
    "intensidade": "forte",
    "modificadores": "Quick cuts, energetic pacing, urgent movement"
  }
}
```

### 📚 Erro + Correção
```json
{
  "tts": {
    "voz": "nova",
    "velocidade": 1.0,
    "tom": "educativo_amigavel"
  },
  "musica": {
    "volume": 0.08,
    "tipo": "leve_positivo"
  },
  "veo": {
    "intensidade": "moderado",
    "modificadores": "Clear visuals, steady pace, friendly atmosphere"
  }
}
```

## 🎯 Exemplos Práticos

### Exemplo 1: Vídeo Viral para Instagram
```javascript
{
  "tema": "erro no banho que atrasa fala",
  "preset": "explosao_viral",
  "modo": "veo",
  "duracao": 30,
  "subTema": "atraso_fala"
}
// Resultado: Voz shimmer rápida + música alta + cenas dinâmicas
```

### Exemplo 2: Autoridade para Feed
```javascript
{
  "tema": "quando procurar fonoaudiologia",
  "preset": "autoridade_inspiradora",
  "modo": "veo",
  "duracao": 45,
  "subTema": "atraso_fala"
}
// Resultado: Voz alloy confiante + música motivacional + cenas profissionais
```

### Exemplo 3: Empatia para Conexão
```javascript
{
  "tema": "preocupação com desenvolvimento",
  "preset": "empatia_emocional",
  "modo": "veo",
  "duracao": 35,
  "subTema": "autismo"
}
// Resultado: Voz shimmer acolhedora + música suave + cenas emocionais
```

## 📊 Comparação: Antes vs Depois

| Aspecto | Antes | Depois (Preset) |
|---------|-------|-----------------|
| **Voz TTS** | `nova` @ 0.95x (lenta) | `shimmer/alloy` @ 1.05x (dinâmica) |
| **Música** | Volume 0.04 (inaudível) | Volume 0.08-0.12 (presente) |
| **VEO** | Cenas calmas, documentais | Cenas energéticas, movimentadas |
| **Hook** | Genérico | Provocativo específico |
| **CTA** | Padrão | Otimizado por objetivo |

## 🛠️ Criar Novo Preset

Edite `/back/config/video-presets-premium.json` e adicione novo preset:

```json
"meu_preset": {
  "nome": "Meu Preset Customizado",
  "objetivo": "Descrição do objetivo",
  "tts": { "voz": "nova", "velocidade": 1.0 },
  "musica": { "volume": 0.10, "tipo": "meu_tipo" },
  "veo": { "intensidade": "forte", "modificadores": "..." }
}
```

## 🔍 Monitorar Performance

Logs mostram qual preset está sendo usado:
```
[VIDEO WORKER] 🎬 Usando preset PREMIUM: "Explosão Viral"
[VIDEO WORKER] 📊 Config: voz=shimmer, speed=1.05, vol=0.12
```

## 💡 Dicas Profissionais

1. **Teste A/B**: Crie mesmo vídeo com presets diferentes e compare engajamento
2. **Segmente por Plataforma**: 
   - Reels/TikTok → `explosao_viral`
   - Feed → `autoridade_inspiradora` ou `erro_correcao`
   - Stories → `empatia_emocional`
   - Ads → `alerta_urgencia`

3. **Hook é 80% do resultado**: Mesmo com preset premium, o texto do hook precisa ser provocativo

4. **Consistência de Marca**: Mantenha o tom emocional alinhado à identidade da Fono Inova

---

**Arquivos do Sistema:**
- Configurações: `/back/config/video-presets-premium.json`
- Serviço: `/back/services/video/presetService.js`
- Integração: `/back/workers/video.worker.js`
