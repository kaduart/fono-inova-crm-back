# 🎨 Sistema de Layouts v2 - Fono Inova

Sistema avançado de geração de posts para Instagram com **15+ layouts dinâmicos**, **rotação automática** e **persistência de histórico**.

---

## 🚀 Quick Start

### Gerar post com layout automático

```bash
POST /api/instagram/generate-v2
{
  "especialidadeId": "fonoaudiologia",
  "headline": "Seu filho ainda não fala?",
  "caption": "Texto completo da legenda...",
  "hook": "Atraso na fala pode ser sinal...",
  "funnelStage": "top"
}
```

**Resposta:**
```json
{
  "success": true,
  "data": {
    "postId": "65a1b2c3...",
    "mediaUrl": "https://res.cloudinary.com/...",
    "layout": {
      "id": "hero_banner_curva",
      "nome": "Banner Curva Clássico",
      "categoria": "foto_terapia"
    },
    "provider": "fal-flux-dev",
    "tempo": "8.5s",
    "proximoLayoutSugerido": "dual_screen_psico"
  }
}
```

---

## 📐 Os 15+ Layouts Disponíveis

### Categorias por Especialidade

| Especialidade | Categorias Preferidas |
|--------------|----------------------|
| fonoaudiologia | foto_terapia, educativo, tecnico |
| psicologia | emocional, educativo, conscientizacao |
| terapia_ocupacional | foto_terapia, ilustracao, beneficios |
| fisioterapia | foto_terapia, motora |
| neuropsicologia | emocional, conscientizacao |

### Lista Completa de Layouts

| ID | Nome | Categoria | Foto Ratio |
|-----|------|-----------|------------|
| `hero_banner_curva` | Banner Curva Clássico | foto_terapia | 65% |
| `dual_screen_psico` | Tela Dupla Emocional | emocional | 55% |
| `comparativo_losango` | Atraso X Transtorno | educativo_comparativo | 0% |
| `checklist_sinais` | Checklist Sinais Alerta | informativo_lista | 30% |
| `data_comemorativa` | Dia do Profissional | datas | 75% |
| `video_reels` | Frame Vídeo/Reels | video | 100% |
| `metodo_autoridade` | Layout Autoridade | autoridade | 70% |
| `beneficios_terapia` | Lista de Benefícios | beneficios | 45% |
| `escolha_clinica` | Por Que Escolher | institucional | 80% |
| `tdah_conscientizacao` | TDAH/Neuro Consciência | conscientizacao | 50% |
| `dificuldade_escolar` | Problemas Escolares | escolar | 60% |
| `desenvolvimento_fases` | Fases do Desenvolvimento | educativo | 35% |
| `ansiedade_infantil` | Ansiedade/Emocional | emocional | 40% |
| `fisioterapia_motora` | Fisioterapia Motora | motora | 70% |
| `arte_3d_terapia` | Ilustração 3D Terapia | ilustracao | 0% |
| `caa_comunicacao` | Comunicação Alternativa | tecnico | 40% |

---

## 🔄 Sistema de Rotação (Round-Robin)

### Como funciona:

1. **Seleção Inteligente**: Filtra layouts compatíveis com a especialidade
2. **Evita Repetição**: Remove os últimos 3 layouts usados do pool
3. **Round-Robin**: Seleciona o próximo da lista circular
4. **Persistência**: Histórico salvo no MongoDB (survive restart)

### Exemplo de fluxo:

```
Post 1: hero_banner_curva (fonoaudiologia)
Post 2: dual_screen_psico (psicologia)
Post 3: checklist_sinais (fonoaudiologia)
Post 4: hero_banner_curva (fonoaudiologia) ← Permitido (não está nos últimos 3)
```

---

## 🔌 Endpoints da API

### Geração

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| `POST` | `/api/instagram/generate-v2` | Gera post com layout automático |
| `POST` | `/api/instagram/posts/:id/regenerate` | Regenera imagem com novo layout |

### Previews (Testes)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| `POST` | `/api/instagram/preview/layout` | Preview de layout específico |
| `POST` | `/api/instagram/preview/auto` | Preview com seleção automática |

### Configurações

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| `GET` | `/api/instagram/layouts` | Lista todos os layouts |
| `GET` | `/api/instagram/layouts?especialidadeId=fonoaudiologia` | Filtra por especialidade |
| `GET` | `/api/instagram/layouts/stats` | Estatísticas de uso |
| `GET` | `/api/instagram/especialidades` | Mapeamento de categorias |

---

## 📝 Exemplos de Uso

### Preview de layout específico

```bash
POST /api/instagram/preview/layout
{
  "layoutId": "hero_banner_curva",
  "especialidadeId": "fonoaudiologia",
  "headline": "Seu filho ainda não fala?",
  "hook": "Descubra como podemos ajudar"
}
```

### Listar layouts por especialidade

```bash
GET /api/instagram/layouts?especialidadeId=psicologia
```

Resposta:
```json
{
  "success": true,
  "data": {
    "total": 5,
    "layouts": [
      { "id": "dual_screen_psico", "nome": "Tela Dupla Emocional", ... },
      { "id": "ansiedade_infantil", "nome": "Ansiedade/Emocional", ... }
    ]
  }
}
```

---

## 🎨 Especificações Técnicas

### Renderização

- **Engine**: Sharp + SVG dinâmico
- **Resolução**: 1080x1080px (Instagram)
- **Formato**: WebP (qualidade 95%)
- **Fonte**: Montserrat (fallback: Arial)

### Paleta de Cores

```javascript
{
  verdeProfundo: '#1A4D3A',  // Primária
  verdeVibrante: '#2E8B57',
  amareloOuro: '#F4D03F',    // Destaque
  rosaCoral: '#F1948A',
  lilas: '#C39BD3',
  branco: '#FFFFFF'
}
```

### Geração de Imagem Base

**Providers (ordem de tentativa):**
1. fal.ai FLUX dev (preferencial)
2. Together.ai FLUX
3. Replicate FLUX
4. Pollinations (fallback gratuito)

---

## 🗄️ Modelos de Dados

### LayoutHistory (MongoDB)

```javascript
{
  channel: 'instagram',
  especialidadeId: 'fonoaudiologia',
  categoria: 'foto_terapia',
  layoutId: 'hero_banner_curva',
  postId: ObjectId('...'),
  usedAt: Date
}
```

### InstagramPost (atualizado)

```javascript
{
  // ... campos existentes ...
  layoutId: 'hero_banner_curva',  // NOVO
  metadata: {
    layoutNome: 'Banner Curva Clássico',
    headlineStrategy: 'foto_terapia'
  }
}
```

---

## ⚙️ Variáveis de Ambiente

```bash
# Providers de Imagem (pelo menos um necessário)
FAL_API_KEY=...
TOGETHER_API_KEY=...
REPLICATE_API_TOKEN=...

# Cloudinary (obrigatório)
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# OpenAI (para headlines/captions)
OPENAI_API_KEY=...
```

---

## 🔧 Manutenção

### Limpar histórico antigo

```javascript
// Remove registros antigos, mantendo apenas últimos 20
await LayoutHistory.cleanupOld('fonoaudiologia', 'instagram', 20);
```

### Estatísticas de uso

```javascript
const stats = await LayoutHistory.getStats('fonoaudiologia');
// Retorna: [{ _id: 'hero_banner_curva', count: 15, lastUsed: Date }, ...]
```

---

## 🔄 Compatibilidade

O sistema v2 é **backward compatible**:

- `/api/instagram/generate` → Usa sistema antigo (brandImageService)
- `/api/instagram/generate-v2` → Usa novo sistema (layoutEngine)
- Posts antigos funcionam normalmente
- Migração gradual possível

---

## 📈 Roadmap

- [ ] FASE 1: 5 layouts essenciais (MVP) ✅
- [ ] FASE 2: 10 layouts (expansão)
- [ ] FASE 3: 15+ layouts completo
- [ ] Templates customizáveis via UI
- [ ] A/B testing de layouts

---

## 🐛 Troubleshooting

### "Nenhum layout disponível"

Verifique se a especialidade está mapeada em `ESPECIALIDADE_CATEGORIAS`.

### "Falha ao gerar imagem"

Verifique se pelo menos um provider (FAL_API_KEY, TOGETHER_API_KEY, etc) está configurado.

### "Layout repetido"

O histórico é persistido no MongoDB. Verifique a collection `layouthistories`.

---

**Desenvolvido com ❤️ para Fono Inova**
