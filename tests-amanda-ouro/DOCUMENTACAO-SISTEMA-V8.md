# 📘 Documentação Técnica - Amanda V8

**Versão:** 8.2.0  
**Data:** 05/04/2026  
**Status:** Produção (com otimizações ativas)

---

## 1. Visão Geral

### 1.1 O que é a Amanda

Amanda é um **orquestrador de conversas clínicas** que processa mensagens de leads do site e WhatsApp da Clínica Fono Inova, direcionando para o fluxo correto baseado em intenção, sintomas clínicos e contexto da conversa.

### 1.2 Objetivo do Sistema

- **Converter** visitantes em agendamentos qualificados
- **Direcionar** leads para a especialidade correta no primeiro contato
- **Proteger** contra falsos positivos (ex: emprego vs paciente)
- **Escalar** atendimento sem perder qualidade humana

---

## 2. Arquitetura

### 2.1 Diagrama de Fluxo

```
┌─────────────────────────────────────────────────────────────────┐
│                         INPUT (mensagem)                        │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STAGE 1: INTENT DETECTION                                      │
│  • detectIntentPriority()                                       │
│  • FIRST_CONTACT | EXPLICACAO | SINTOMA | PRECO | AGENDAMENTO  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STAGE 2: CLINICAL MAPPER  🧠 (NOVO)                            │
│  • resolveClinicalArea()                                        │
│  • Mapeia sintomas → especialidade                              │
│  • Confidence ≥ 0.8 → TEMPLATE OURO                            │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STAGE 3: EMPLOYMENT GUARD  🛡️ (NOVO)                           │
│  • isSafeEmploymentIntent()                                     │
│  • Bloqueia "meu filho" → emprego                               │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STAGE 4: PRIORITY RESOLVER                                     │
│  • resolveBestArea()                                            │
│  • Seleciona domínio dominante                                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STAGE 5: RESPONSE ENGINE                                       │
│  • Template Ouro (empatia + área + CTA)                        │
│  • Resposta programática                                        │
│  • Fallback IA (Groq → OpenAI)                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Componentes Principais

#### 2.2.1 AmandaOrchestrator.js
**Responsabilidade:** Coordenar todo o fluxo de decisão

**Funções principais:**
- `getOptimizedAmandaResponse()` - Entry point
- `detectIntentPriority()` - Classificação de intenção
- `buildDirectedResponse()` - Template Ouro
- `inferAreaFromContext()` - Inferência por contexto

#### 2.2.2 ClinicalMapper.js 🧠
**Responsabilidade:** Mapear sintomas clínicos para especialidades

**Exportações:**
```typescript
export function resolveClinicalArea(message: string): ClinicalResolution
export function detectClinicalSymptoms(message: string): Symptom[]
export function buildDirectedResponse(area: string, condition?: string): string
```

**Confidence Thresholds:**
- `≥ 0.8` → Resposta direta imediata
- `≥ 0.7` → Resposta guiada
- `< 0.7` → Pergunta de esclarecimento

**Mapeamentos ativos:**
| Sintoma | Condição | Área | Confidence |
|---------|----------|------|------------|
| "não fala" | fala_tardia | fonoaudiologia | 0.9 |
| "troca letras" | dislexia | neuropsicologia | 0.9 |
| "hiperativo" | tdah | neuropsicologia | 0.9 |
| "síndrome de down" | sindrome_down | multiprofissional | 0.9 |

#### 2.2.3 EmploymentGuard.js 🛡️
**Responsabilidade:** Prevenir falsos positivos de emprego

**Lógica:**
```typescript
export function isSafeEmploymentIntent(text: string): boolean {
  // BLOCK se contexto de paciente detectado
  if (hasPatientContext(text)) return false;
  
  // ALLOW apenas se keywords de emprego presentes
  return hasEmploymentKeywords(text);
}
```

**Indicadores de paciente:**
- "meu filho", "minha filha", "paciente"
- Sintomas: "não fala", "dislexia", "atraso"

#### 2.2.4 PriorityResolver.js
**Responsabilidade:** Resolver a melhor área quando múltiplas possibilidades

**Regras (em ordem de prioridade):**
1. Keywords explícitas no texto (confidence 0.9)
2. Page source (SEO da landing page)
3. Histórico do lead
4. Fallback: null (não assume)

**IMPORTANTE:** Não inferir especialidade de nomes de clínicas (ex: "Fono Inova" ≠ fonoaudiologia)

---

## 3. Regras de Decisão

### 3.1 Matriz de Decisão

| Condição | Confiança | Ação |
|----------|-----------|------|
| ClinicalMapper detectou área | ≥ 0.8 | Template Ouro (resposta direta) |
| ClinicalMapper detectou área | ≥ 0.7 | Resposta guiada |
| Intent = SINTOMA + Clinical | - | Empatia + direcionamento |
| Intent = EMPREGO + SafeGuard | - | Resposta de recrutamento |
| Intent = EMPREGO + PatientCtx | - | Bloqueia (é paciente!) |
| Intent = AGENDAMENTO + hasArea | - | Oferece slots |
| Intent = PRECO | - | Mostra valores |
| Nenhuma condição acima | - | Fallback IA |

### 3.2 Template Ouro

**Estrutura:**
```
{Empatia contextual} 💚

Pelo que você descreveu, a {Área} pode ajudar bastante nesse caso.

Você prefere que eu te explique como funciona ou já quer ver os horários disponíveis? 😊
```

**Frases de empatia por condição:**
| Condição | Empatia |
|----------|---------|
| fala_tardia | "Entendo sua preocupação com o desenvolvimento da fala 💚" |
| dislexia | "Compreendo a importância de investigar as dificuldades de leitura 💚" |
| tea | "Entendo que buscar orientação é o primeiro passo 💚" |
| default | "Entendo sua preocupação 💚" |

### 3.3 Guards e Proteções

#### Anti-Loop Guard
```typescript
if (isTriageComplete(lead)) {
  // Nunca repetir pergunta já respondida
  return offerSlots(lead);
}
```

#### Employment Guard
```typescript
if (wantsJob && !isSafeEmploymentIntent(text)) {
  // Lead mencionou "meu filho" + "trabalhar" = paciente, não candidato
  context.flags.wantsJobOrInternship = false;
}
```

---

## 4. Fluxo Completo (Exemplo)

### Caso: "meu filho não fala direito"

```
1. INPUT: "meu filho não fala direito"
   
2. INTENT DETECTION: SINTOMA
   → forceEmpathy = true
   
3. CLINICAL MAPPER:
   → detecta "não fala" → fala_tardia
   → area = fonoaudiologia
   → confidence = 0.9
   → forcePatientCare = true
   
4. EMPLOYMENT GUARD:
   → detecta "meu filho" (patient context)
   → bloqueia se houver keywords de emprego
   
5. EARLY RETURN (confidence ≥ 0.8):
   → return buildDirectedResponse("fonoaudiologia", "fala_tardia")
   
6. OUTPUT:
   "Entendo sua preocupação com o desenvolvimento da fala 💚
   
   Pelo que você descreveu, a Fonoaudiologia pode ajudar bastante nesse caso.
   
   Você prefere que eu te explique como funciona ou já quer ver os horários disponíveis? 😊"
```

---

## 5. Configuração e Deploy

### 5.1 Variáveis de Ambiente

```bash
# Obrigatórias
MONGO_URI=mongodb://...
REDIS_HOST=localhost
REDIS_PORT=6379

# APIs de IA (prioridade: Groq → OpenAI)
GROQ_API_KEY=gsk_xxxxx              # Grátis, primeiro
OPENAI_API_KEY=sk-proj-xxxxx        # Fallback (NUNCA usar sk-test)

# Opcional
WHATSAPP_API_KEY=...
CLINIC_TIMEZONE=America/Sao_Paulo
```

### 5.2 Validação de API Key

O sistema agora valida a API key no startup:

```typescript
if (key.includes("test") || key.includes("dummy")) {
  throw new Error("🚨 OPENAI_API_KEY contém valor de teste!");
}
```

### 5.3 Monitoramento

**Logs críticos para observar:**
```
[CLINICAL MAPPER] Specialty detectada: {area} ({condition}, conf: {confidence})
[TEMPLATE OURO - EARLY RETURN] Resposta direcionada para: {area}
[EmploymentGuard] BLOQUEADO: Contexto de paciente detectado
[ERROR] OPENAI_API_KEY inválida
```

---

## 6. Testes

### 6.1 Suite de Testes

| Script | Propósito |
|--------|-----------|
| `SCRIPT-qa-cenarios-criticos.js` | 13 cenários obrigatórios |
| `SCRIPT-testar-site-completo.js` | 52 cenários do site |
| `SCRIPT-analisar-respostas.js` | Classificação automática |

### 6.2 Cenários Críticos

```typescript
const CENARIOS_CRITICOS = [
  { id: 1, entrada: 'oi', intencao: 'FIRST_CONTACT' },
  { id: 3, entrada: 'meu filho não fala direito', intencao: 'SINTOMA' },
  { id: 5, entrada: 'quanto custa', intencao: 'PRECO', deveConter: ['r$'] },
  // ...
];
```

### 6.3 Critérios de Aprovação

- **Taxa de sucesso:** ≥ 85% nos cenários críticos
- **Erros técnicos:** < 5%
- **Respostas excelentes:** ≥ 40% (meta: 70%)

---

## 7. Troubleshooting

### 7.1 "Amanda pergunta qual área quando já mencionei"

**Causa:** ClinicalMapper não detectou ou confidence < 0.8  
**Solução:** Verificar se sintoma está mapeado em `CLINICAL_MAP`

### 7.2 "Amanda confundiu paciente com emprego"

**Causa:** EmploymentGuard não ativo ou bypassado  
**Solução:** Verificar ordem de execução (deve ser antes de responder)

### 7.3 "Erro: Todos os providers falharam"

**Causa:** API key inválida ou expirada  
**Solução:** Verificar `OPENAI_API_KEY` (deve começar com `sk-proj` ou `sk-live`)

### 7.4 "Resposta genérica sem direcionamento"

**Causa:** Template Ouro não acionado  
**Verificar:**
1. `clinicalResolution.confidence >= 0.8`
2. Early return está no início do pipeline
3. Não há outro return antes

---

## 8. Roadmap

### 8.1 Curto Prazo (1-2 semanas)

- [ ] Ajustar confidence threshold (0.8 → 0.7)
- [ ] Expandir ClinicalMapper para Fono/Psico/TO
- [ ] Corrigir API key em produção

### 8.2 Médio Prazo (1 mês)

- [ ] Context Memory (evitar repetição)
- [ ] Personalização por persona
- [ ] A/B test de templates

### 8.3 Longo Prazo (3 meses)

- [ ] Fine-tuning de modelo próprio
- [ ] Predição de churn
- [ ] Integração com prontuário eletrônico

---

## 9. Referências

### 9.1 Arquivos Principais

```
back/
├── orchestrators/
│   ├── AmandaOrchestrator.js      # Entry point
│   └── decision/
│       ├── ClinicalMapper.js      # Mapeamento sintomas
│       ├── EmploymentGuard.js     # Proteção emprego
│       └── PriorityResolver.js    # Resolução de área
├── services/IA/
│   └── Aiproviderservice.js       # Provider IA
└── tests-amanda-ouro/
    ├── scripts/                   # Testes
    └── relatorios/                # Resultados
```

### 9.2 Documentação Relacionada

- `ARQUITETURA_FINAL.md` - Arquitetura completa
- `AMANDA-INTENT-SYSTEM.md` - Sistema de intenções
- `RELATORIO-EVOLUCAO-V8.md` - Métricas de evolução

---

**Versão:** 8.2.0  
**Última atualização:** 05/04/2026  
**Responsável:** Dev Team
