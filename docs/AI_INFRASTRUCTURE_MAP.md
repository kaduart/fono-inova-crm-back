# 🧠 MAPA COMPLETO DA INFRAESTRUTURA DE IA

**Gerado em:** 2026-02-15
**Objetivo:** Evitar duplicação de esforços e entender arquitetura existente

---

## 📋 RESUMO EXECUTIVO

O projeto já possui uma **infraestrutura robusta de IA/Intelligence** com:
- ✅ **19 serviços de intelligence** modulares
- ✅ **Sistema de aprendizado contínuo** (análise de conversas reais)
- ✅ **Detectores especializados** (flags, terapias)
- ✅ **Padrões de mundo real** extraídos e configurados
- ✅ **Provider unificado** com fallback (Groq → OpenAI)

**⚠️ PROBLEMA IDENTIFICADO:**
Existe **sobreposição** entre:
1. `flagsDetector.js` (monolítico, 572 linhas)
2. `leadIntelligence.js` (extração estruturada)
3. `real-world-training.js` (padrões de edge cases)
4. `ConversationAnalysisService.js` + `PatternRecognitionService.js` (learning)

**📌 RECOMENDAÇÃO:**
Não criar nova infraestrutura. **Refatorar e consolidar a existente.**

---

## 1. CAMADA DE PROVIDERS DE IA

### 1.1. Provider Unificado
**Arquivo:** `/services/IA/Aiproviderservice.js`

```javascript
callAI({systemPrompt, messages, maxTokens, temperature, usePremiumModel})
  ↓
  1️⃣ Groq (llama-3.1-8b-instant) - PRIMARY
  2️⃣ Groq Premium (llama-3.1-70b-versatile) - se usePremiumModel=true
  3️⃣ OpenAI (gpt-4o-mini) - FALLBACK
```

**Status:** ✅ **Bem implementado**
**Não precisa de refatoração**

### 1.2. Serviço Amanda (Legado)
**Arquivo:** `/services/aiAmandaService.js`

Wrapper antigo do OpenAI. Provavelmente **deprecated** em favor do `Aiproviderservice.js`.

**Ação:** 🔍 Verificar se ainda é usado e depreciar se não for.

---

## 2. CAMADA DE DETECÇÃO (PATTERN MATCHING)

### 2.1. FlagsDetector (Monolítico - 572 linhas)
**Arquivo:** `/utils/flagsDetector.js`

**O que detecta:**
- ✅ 50+ flags de intenção (asksPrice, wantsSchedule, mentionsUrgency, etc.)
- ✅ Perfil do usuário (baby, school, behavior, emotional, etc.)
- ✅ Faixa etária (criança, adolescente, adulto)
- ✅ Contexto conversacional (stage, messageCount, isReturningLead)
- ✅ Fluxo de agendamento (inSchedulingFlow, wantsSchedulingNow)

**Funções principais:**
```javascript
deriveFlagsFromText(text)         // Regex puro (200+ linhas)
detectAllFlags(text, lead, context) // Flags + contexto
resolveTopicFromFlags(flags, text)  // Especialidade
computeTeaStatus(flags, text)       // TEA: laudo_confirmado | suspeita
detectUserProfile(text, lead, context) // Perfil comportamental
```

**Problemas:**
- ❌ Monolítico (difícil manter)
- ❌ Lógica de negócio misturada (isNewLead, visitLeadHot, inSchedulingFlow)
- ❌ Regex hardcoded (não aprende com conversas reais)
- ❌ Sem métricas de acurácia

**Oportunidades:**
- ✅ Já tem estrutura de flags bem pensada
- ✅ Pode ser migrado para nova arquitetura modular (BaseDetector + especializados)

---

### 2.2. TherapyDetector
**Arquivo:** `/utils/therapyDetector.js`

**O que faz:**
- ✅ Detecta especialidades mencionadas (fono, psico, TO, fisio, etc.)
- ✅ Normaliza termos (remove nome da clínica)
- ✅ Detecta fora de escopo (audiometria, BERA, PEATE)

**Estrutura:**
```javascript
THERAPY_SPECIALTIES = {
  neuropsychological: { symptoms, ageRange, duration, priceTier },
  speech: {...},
  tongue_tie: {...},
  // ...
}

detectAllTherapies(text) → [{ id, name, allNames }]
```

**Status:** ✅ **Bem estruturado**
**Ação:** Manter, mas integrar com sistema de learning para melhorar detecção

---

### 2.3. LeadIntelligence (Extração Estruturada)
**Arquivo:** `/services/intelligence/leadIntelligence.js`

**O que extrai:**
```javascript
{
  idade, idadeRange, parentesco,
  queixa, queixaDetalhada, especialidade,
  urgencia, planoSaude, disponibilidade,
  proximaAcaoDeclarada, bloqueioDecisao, mencionaTerceiro
}
```

**Sobreposição com FlagsDetector:**
- ✅ Ambos extraem idade, especialidade, urgência
- ✅ Ambos detectam queixas/sintomas
- ❌ **Duplicação de lógica**

**Ação:** 🔧 **Consolidar** com FlagsDetector na nova arquitetura

---

## 3. CAMADA DE INTELLIGENCE (DECISÃO E CONTEXTO)

### 3.1. Serviços Intelligence (/services/intelligence/)

| Arquivo | Responsabilidade | Status |
|---------|-----------------|--------|
| `ContextManager.js` | Gerencia contexto da conversa | ✅ Core |
| `ContextPack.js` | Empacota contexto para o prompt | ✅ Core |
| `ModeRouter.js` | Roteamento de modo (closer, acolhimento, etc.) | ✅ Core |
| `conversationMode.js` | Define modo da conversa | ✅ Core |
| `stageEngine.js` | Máquina de estados do funil | ✅ Core |
| `leadIntelligence.js` | Extração estruturada (ver acima) | 🔧 Consolidar |
| `UrgencyScheduler.js` | Prioriza agendamentos urgentes | ✅ Core |
| `smartFollowup.js` | Follow-ups inteligentes | ✅ Core |
| `ghostRecovery.js` | Recuperação de leads inativos | ✅ Core |
| `naturalResponseBuilder.js` | Constrói respostas naturais | ✅ Core |
| `pricingStrategy.js` | Estratégia de precificação | ✅ Core |
| `intentScorePersistence.js` | Persiste scores de intenção | ✅ Core |
| `analytics.js` | Analytics de conversas | ✅ Core |
| `memoryWindow.js` | Janela de memória | ✅ Core |
| `EntityValidator.js` | Valida entidades extraídas | ✅ Core |
| `WhitelistManager.js` | Whitelist de números | ✅ Core |

**Total:** 16 serviços core + 3 de learning = 19 serviços

**Status:** ✅ **Arquitetura bem modularizada**
**Não precisa refatoração, apenas integração**

---

## 4. CAMADA DE APRENDIZADO CONTÍNUO

### 4.1. Continuous Learning System

**Arquivos principais:**
```
services/
  ├── amandaLearningService.js          # Extrai de conversas convertidas
  ├── LearningInjector.js               # Injeta no prompt (cache 4h)
  └── intelligence/
      ├── ContinuousLearningService.js  # Orquestra ciclo completo
      ├── ConversationAnalysisService.js # Analisa conversas do MongoDB
      └── PatternRecognitionService.js   # Detecta padrões
```

**Fluxo:**
```
1. learningCron.js (23h diariamente)
   ↓
2. ContinuousLearningService.runLearningCycle()
   ↓
3. ConversationAnalysisService.fetchRecentConversations()
   ↓
4. PatternRecognitionService.analyzePatterns()
   ↓
5. amandaLearningService.analyzeHistoricalConversations()
   ↓
6. Salva em MongoDB (LearningInsight)
   ↓
7. LearningInjector.getActiveLearnings() [cache 4h]
   ↓
8. AmandaPrompt usa learnings no context
```

**O que aprende:**
- ✅ Melhores aberturas que converteram
- ✅ Respostas de preço efetivas
- ✅ Perguntas de fechamento que funcionam
- ✅ Negative scope (o que a clínica NÃO faz)
- ✅ Padrões de problemas (cancelamento, confusão, silence_after_price)

**Status:** ✅ **Sistema completo e funcional**
**Problema:** Não alimenta os detectores (FlagsDetector, TherapyDetector)

---

### 4.2. Real World Training Config
**Arquivo:** `/config/real-world-training.js`

**Padrões extraídos manualmente:**
```javascript
FALLBACK_TRIGGERS: [
  { pattern: /^(ok|sim)$/i, context: 'short_reply', action: 'interpret_with_context' },
  { pattern: /(dois filhos|duas crianças)/i, action: 'apply_family_discount' },
  { pattern: /(gripou|doente)/i, action: 'reschedule_with_waiver' }
]

NOT_COMPLAINT: [
  /(aceitam?|tem).*?(plano|convênio)/i,
  /(quanto custa|qual o valor)/i
]

SPECIALTY_DETECTION: [
  { pattern: /dificuldade na escola/i, specialty: 'psicopedagogia', not: 'psicologia' }
]

EDGE_CASES: {
  saturday_request: { pattern, response, offer },
  early_morning: { pattern, response, confirm }
}
```

**Status:** ✅ **Excelente fonte de padrões reais**
**Ação:** 🔧 **Migrar para intent-patterns.js** e alimentar detectores

---

## 5. CAMADA DE PROMPTS

### 5.1. AmandaPrompt
**Arquivo:** `/utils/amandaPrompt.js`

**Funções:**
```javascript
buildSystemPrompt(context) → prompt dinâmico
buildUserPrompt(userMessage, context) → contexto completo
shouldOfferScheduling(context) → boolean
```

**Context injetado:**
- ✅ therapyArea, patientAge, patientName, complaint
- ✅ emotionalContext, intentScore, lastTopics
- ✅ wisdom (de clinicWisdom.js)
- ✅ learnings (de LearningInjector)
- ✅ negativeScope (o que não fazemos)

**Status:** ✅ **Bem estruturado**
**Oportunidade:** Adicionar "enforcement layer" pós-LLM

---

## 6. ARQUIVOS CRIADOS RECENTEMENTE (NOVA ARQUITETURA)

### 6.1. Intent Patterns Config
**Arquivo:** `/config/intent-patterns.js` ✨ **NOVO**

Consolidação de padrões de:
- price, scheduling, location, insurance, urgency
- cancellation, refusal, confirmation, already_scheduled
- medical_condition, special_requests
- user_profile, age_group

**Status:** 📦 **Pronto para usar**

### 6.2. BaseDetector
**Arquivo:** `/detectors/BaseDetector.js` ✨ **NOVO**

Classe base com:
- ✅ Detecção com confidence score
- ✅ Learning incremental (addFeedback)
- ✅ Auto-geração de padrões
- ✅ Métricas (accuracy, precision)
- ✅ Export/import de padrões aprendidos
- ✅ Debugging (explain)

**Status:** 📦 **Pronto para usar**

---

## 7. ANÁLISE DE DUPLICAÇÃO

### ❌ DUPLICAÇÕES IDENTIFICADAS

| Funcionalidade | Arquivo 1 | Arquivo 2 | Ação |
|----------------|-----------|-----------|------|
| Detecção de idade | `flagsDetector.extractAgeGroup()` | `leadIntelligence.extractStructuredData().idade` | Consolidar |
| Detecção de especialidade | `flagsDetector.resolveTopicFromFlags()` | `leadIntelligence.especialidades` | Consolidar |
| Detecção de urgência | `flagsDetector.mentionsUrgency` | `leadIntelligence.urgencia` | Consolidar |
| Detecção de queixa | `flagsDetector` (implícito em flags) | `leadIntelligence.queixas` | Consolidar |
| Padrões de edge cases | `real-world-training.EDGE_CASES` | `PatternRecognitionService.KNOWN_PROBLEM_PATTERNS` | Unificar fonte |

---

## 8. PLANO DE REFATORAÇÃO (RECOMENDADO)

### 🎯 FASE 1: Consolidação (NÃO criar novo, UNIFICAR existente)

#### Passo 1: Migrar padrões para `intent-patterns.js`
- ✅ Extrair todos regex de `flagsDetector.deriveFlagsFromText()`
- ✅ Extrair padrões de `real-world-training.js`
- ✅ Extrair padrões de `PatternRecognitionService.KNOWN_PROBLEM_PATTERNS`
- ✅ Consolidar em **fonte única de verdade**

#### Passo 2: Refatorar FlagsDetector em módulos
Criar detectores especializados herdando de `BaseDetector`:
```
detectors/
  ├── BaseDetector.js          [✅ JÁ CRIADO]
  ├── PriceDetector.js         [criar]
  ├── SchedulingDetector.js    [criar]
  ├── EmotionalDetector.js     [criar]
  ├── ProfileDetector.js       [criar]
  ├── AgeDetector.js           [criar]
  └── IntentOrchestrator.js    [criar - coordena todos]
```

#### Passo 3: Criar adaptador de compatibilidade
```javascript
// adapters/LegacyFlagsAdapter.js
export function adaptToLegacyFormat(newIntentResult) {
  return {
    asksPrice: newIntentResult.price.detected,
    wantsSchedule: newIntentResult.scheduling.detected,
    // ... mapeamento completo
    _meta: { confidence, version: '2.0' }
  };
}
```

#### Passo 4: Integrar Learning com Detectores
```
ContinuousLearningService
   ↓
PatternRecognitionService.detectPatternInConversations()
   ↓
BaseDetector.addFeedback() [cada detector aprende]
   ↓
BaseDetector.exportLearnedPatterns()
   ↓
intent-patterns.js (atualização automática)
```

---

### 🎯 FASE 2: Enforcement Layer (Pós-LLM)

Criar validador estrutural para garantir qualidade da resposta:

```javascript
// services/intelligence/ResponseEnforcer.js
export function enforceStructure(llmResponse, context) {
  if (context.intent === 'price') {
    if (!hasPrice(llmResponse)) {
      llmResponse += `\n\nO investimento é ${context.pricing} 💚`;
    }
    if (!hasPriceContext(llmResponse)) {
      llmResponse = addPriceContext(llmResponse);
    }
  }

  if (context.intent === 'scheduling') {
    if (!hasCTA(llmResponse)) {
      llmResponse += `\n\nPosso verificar horários para você? 💚`;
    }
  }

  return llmResponse;
}
```

---

## 9. DECISÃO FINAL

### ❌ NÃO FAZER:
- Criar nova infraestrutura de detectores
- Duplicar lógica de learning
- Criar novo sistema de padrões

### ✅ FAZER:
1. **Consolidar** `flagsDetector.js` → arquitetura modular com `BaseDetector`
2. **Migrar** padrões de `real-world-training.js` → `intent-patterns.js`
3. **Integrar** `leadIntelligence.extractStructuredData()` → novos detectores
4. **Conectar** learning existente → feedback dos detectores
5. **Criar** enforcement layer para validar respostas do LLM
6. **Manter** toda infraestrutura de intelligence services (está ótima)

---

## 10. PRÓXIMOS PASSOS

1. ✅ **PAUSAR** criação de novos arquivos
2. 🔍 **AUDITAR** dependências de `flagsDetector.js` no código
3. 🔧 **REFATORAR** modularmente (1 detector por vez)
4. 🧪 **TESTAR** compatibilidade com adapter
5. 📊 **MONITORAR** acurácia dos detectores
6. 🚀 **DEPLOY** incremental (feature flag)

---

**Atualizado:** 2026-02-15
**Responsável:** Claude Code
**Status:** 📋 Aguardando aprovação para refatoração
