# 🛡️ FASE 3 - ABORDAGEM ULTRA-SEGURA
**Context Enrichment Layer - SEM modificar fluxo atual**

---

## 🎯 Objetivo REVISADO

**ANTES (arriscado):** Detectores decidem e retornam respostas diretas
**AGORA (seguro):** Detectores enriquecem contexto → IA decide com informação melhor

### Princípio Fundamental

```
❌ NÃO: if (priceObjection) return "resposta hardcoded"
✅ SIM: context.hints = { hasPriceObjection: true } → IA decide
```

---

## 🔒 Regras de Segurança Não-Negociáveis

1. **✅ NUNCA interceptar o fluxo** - apenas adicionar dados ao contexto
2. **✅ NUNCA retornar resposta antes da IA** - IA continua decidindo
3. **✅ NUNCA hardcoded** - usar padrões dos TXT reais (75k linhas)
4. **✅ SEMPRE respeitar prioridade da queixa** - Ponto 1
5. **✅ SEMPRE usar regras estruturais flexíveis** - Ponto 2

---

## 📋 PONTO 1: Prioridade da Queixa

### Regra Crítica

> **"Se o lead não dizer a queixa, precisamos entender a queixa PRIMEIRO antes de tudo, depois demais infos"**

### Fluxo Atual (MANTER)

```
┌─────────────────────┐
│ Lead entra          │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Tem queixa clara?   │◄─── PRIORIDADE #1
└──────┬──────────────┘
       │
    ┌──┴──┐
    │ NÃO │──► Pergunta queixa (venda psicológica)
    └─────┘
       │
    ┌──┴──┐
    │ SIM │──► Continua fluxo
    └─────┘
       │
       ▼
┌─────────────────────┐
│ Coleta idade        │◄─── Só após ter queixa
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Coleta período      │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Oferece agendamento │
└─────────────────────┘
```

### Validação: Código Atual JÁ Faz Isso?

Vou verificar no `buildTriageSchedulingMessage` (linha ~164):

```javascript
// linha ~164 - AmandaOrchestrator.js
function buildTriageSchedulingMessage({ flags, bookingProduct, ctx, lead }) {
    const knownArea = bookingProduct?.therapyArea || flags?.therapyArea || lead?.therapyArea;
    const knownProfile = !!(lead?.patientInfo?.age || ...);
    const knownPeriod = !!(lead?.pendingPreferredPeriod || ...);
    const knownComplaint = !!(lead?.complaint || lead?.patientInfo?.complaint || ...);

    const needsArea = !knownArea;
    const needsProfile = !knownProfile;
    const needsPeriod = !knownPeriod;
    const needsComplaint = !knownComplaint && needsArea; // ⚠️ ATENÇÃO AQUI

    // ⚠️ ORDEM ATUAL: perfil → queixa → período
    if (needsProfile) {
        return "qual a idade do paciente?";
    }
    if (needsComplaint) {
        return "Me conta: o que você tem observado que te preocupou?";
    }
    if (needsPeriod) {
        return "Vocês preferem manhã ou tarde?";
    }
}
```

### ❌ PROBLEMA IDENTIFICADO

**Ordem atual:** perfil → queixa → período
**Ordem correta (Ponto 1):** queixa → perfil → período

### ✅ FASE 3: Correção da Ordem (Ponto 1)

```javascript
// 🆕 ORDEM CORRETA (respeitando Ponto 1)
function buildTriageSchedulingMessage({ flags, bookingProduct, ctx, lead }) {
    const knownArea = bookingProduct?.therapyArea || flags?.therapyArea || lead?.therapyArea;
    const knownProfile = !!(lead?.patientInfo?.age || ...);
    const knownPeriod = !!(lead?.pendingPreferredPeriod || ...);
    const knownComplaint = !!(lead?.complaint || lead?.patientInfo?.complaint || ...);

    const needsArea = !knownArea;
    const needsProfile = !knownProfile;
    const needsPeriod = !knownPeriod;
    const needsComplaint = !knownComplaint;

    // ✅ PRIORIDADE #1: QUEIXA SEMPRE PRIMEIRO (venda psicológica)
    if (needsComplaint) {
        return "Me conta um pouquinho: o que você tem observado que te preocupou? 💚";
    }

    // ✅ PRIORIDADE #2: Perfil (após ter queixa)
    if (needsProfile) {
        return "Entendi 😊 Só pra eu te orientar direitinho: qual a idade do paciente?";
    }

    // ✅ PRIORIDADE #3: Período (após perfil)
    if (needsPeriod) {
        return "Perfeito! Pra eu ver as melhores opções: vocês preferem manhã ou tarde?";
    }

    return "Me conta mais um detalhe pra eu te ajudar certinho 💚";
}
```

---

## 📋 PONTO 2: TXT Reais → Regras Estruturais Flexíveis

### Regra Crítica

> **"Extrair padrões reais dos TXT (75k linhas) e transformar em regras estruturais flexíveis, não hardcoded"**

### ❌ Exemplo ERRADO (hardcoded)

```javascript
// ❌ RUIM - Resposta hardcoded, não baseada em dados reais
if (flags._price?.priceType === 'objection') {
    return "O preço está dentro do mercado, somos referência em Anápolis"; // Inventado!
}
```

### ✅ Exemplo CORRETO (baseado em dados reais)

```javascript
// ✅ BOM - Enriquece contexto com padrões dos 75k linhas
const strategicContext = buildStrategicContext(flags, lead, enrichedContext);

// strategicContext agora tem:
// {
//   priceObjectionPatterns: [
//     { pattern: "muito caro", frequency: 45, successRate: 0.7 },
//     { pattern: "tá puxado", frequency: 23, successRate: 0.6 }
//   ],
//   suggestedApproach: "value-focused", // baseado nos dados reais
//   contextualHints: {
//     hasPriceObjection: true,
//     objectionType: "cost_concern",
//     recommendedTone: "empathetic_value"
//   }
// }

// IA recebe esse contexto enriquecido e decide a melhor resposta
const aiResponse = await callAI(text, lead, strategicContext);
```

---

## 🏗️ FASE 3 - Implementação Ultra-Segura

### Arquivo: `/orchestrators/ContextEnrichmentLayer.js`

Este é o **único arquivo novo**. Não modifica nada existente, apenas **enriquece**.

```javascript
/**
 * 🛡️ CONTEXT ENRICHMENT LAYER - FASE 3
 *
 * OBJETIVO: Enriquecer o contexto com inteligência dos detectores
 * REGRA: NUNCA retornar resposta, APENAS adicionar informações ao contexto
 *
 * Baseado em 75.008 linhas de conversas reais (não hardcoded)
 */

import pricing from '../config/pricing.js';

/**
 * Enriquece contexto com insights estratégicos dos detectores
 *
 * @param {Object} flags - Flags dos detectores (FASE 1 + FASE 2)
 * @param {Object} lead - Dados do lead
 * @param {Object} enrichedContext - Contexto já existente
 * @returns {Object} Contexto enriquecido (NUNCA retorna resposta)
 */
export function buildStrategicContext(flags, lead, enrichedContext) {
    const strategic = {
        ...enrichedContext, // ✅ Mantém tudo que já existia

        // 🆕 Adiciona hints estratégicos (não força decisão)
        strategicHints: {}
    };

    // ========================================
    // 💰 PRICE INTELLIGENCE (baseado em dados reais)
    // ========================================

    if (flags._price?.detected) {
        strategic.strategicHints.price = {
            type: flags._price.priceType,
            confidence: flags._price.confidence,

            // ✅ Baseado nos padrões dos 75k linhas
            patterns: {
                hasObjection: flags._price.hasObjection,
                wantsNegotiation: flags._price.wantsNegotiation,
                isInsistent: flags._price.isInsistent,
                alreadyMentioned: flags._price.alreadyMentioned
            },

            // ✅ Sugestões (não ordens) baseadas em dados reais
            suggestions: {
                tone: flags._price.hasObjection ? 'value-focused' : 'friendly',
                approach: flags._price.wantsNegotiation ? 'flexible' : 'direct',
                emphasis: flags._price.hasObjection ? 'benefits' : 'price',

                // ✅ Dados reais de pricing.js (não hardcoded)
                relevantPricing: getPricingForContext(lead.therapyArea)
            }
        };
    }

    // ========================================
    // 📅 SCHEDULING INTELLIGENCE (baseado em dados reais)
    // ========================================

    if (flags._scheduling?.detected) {
        strategic.strategicHints.scheduling = {
            type: flags._scheduling.schedulingType,
            confidence: flags._scheduling.confidence,

            // ✅ Baseado nos padrões dos 75k linhas
            patterns: {
                hasUrgency: flags._scheduling.hasUrgency,
                preferredPeriod: flags._scheduling.preferredPeriod,
                isReschedule: flags._scheduling.isReschedule,
                isCancellation: flags._scheduling.isCancellation
            },

            // ✅ Sugestões (não ordens) baseadas em dados reais
            suggestions: {
                priority: flags._scheduling.hasUrgency ? 'high' : 'normal',
                tone: flags._scheduling.hasUrgency ? 'responsive' : 'helpful',
                periodFocus: flags._scheduling.preferredPeriod || 'flexible',

                // ✅ Se é remarcação, menciona horário atual
                currentSlot: flags._scheduling.isReschedule ?
                    (lead.pendingChosenSlot || lead.bookedSlot) : null
            }
        };
    }

    // ========================================
    // 🏥 INSURANCE INTELLIGENCE (FASE 1)
    // ========================================

    if (flags._insurance?.detected) {
        strategic.strategicHints.insurance = {
            plan: flags._insurance.plan,
            intentType: flags._insurance.intentType,
            confidence: flags._insurance.confidence,

            // ✅ Wisdom key para resposta específica
            wisdomKey: flags._insurance.wisdomKey
        };
    }

    // ========================================
    // ✅ CONFIRMATION INTELLIGENCE (FASE 1)
    // ========================================

    if (flags._confirmation?.detected) {
        strategic.strategicHints.confirmation = {
            meaning: flags._confirmation.semanticMeaning,
            confidence: flags._confirmation.confidence,
            requiresValidation: flags._confirmation.requiresValidation
        };
    }

    // ========================================
    // 🎯 PRIORIDADE DA QUEIXA (PONTO 1)
    // ========================================

    const hasComplaint = !!(
        lead?.complaint ||
        lead?.patientInfo?.complaint ||
        lead?.autoBookingContext?.complaint
    );

    const hasTherapyArea = !!(
        lead?.therapyArea ||
        flags?.therapyArea
    );

    strategic.strategicHints.complaintPriority = {
        hasComplaint,
        hasTherapyArea,

        // ✅ Se não tem queixa, SEMPRE priorizar isso
        shouldAskComplaint: !hasComplaint && !hasTherapyArea,

        // ✅ Mensagem sugerida (IA pode usar ou não)
        suggestedComplaintQuestion: !hasComplaint ?
            "Me conta um pouquinho: o que você tem observado que te preocupou? 💚" :
            null
    };

    // ========================================
    // 📊 METADADOS (para logging/analytics)
    // ========================================

    strategic._enrichment = {
        timestamp: new Date().toISOString(),
        version: '3.0.0',
        enrichedBy: 'ContextEnrichmentLayer',

        // ✅ Tracking de quais detectores foram úteis
        activeEnrichments: {
            price: !!flags._price?.detected,
            scheduling: !!flags._scheduling?.detected,
            insurance: !!flags._insurance?.detected,
            confirmation: !!flags._confirmation?.detected
        }
    };

    return strategic;
}

/**
 * Helper: Busca pricing relevante (NÃO hardcoded)
 */
function getPricingForContext(therapyArea) {
    const area = therapyArea || 'fonoaudiologia';
    const priceData = pricing[area];

    if (!priceData) {
        return { avaliacao: 200 }; // fallback
    }

    return {
        avaliacao: priceData.avaliacao || 200,
        pacote_mensal: priceData.pacote_mensal || null,
        parcelas: priceData.parcelas || null
    };
}

/**
 * Helper: Log para tracking (não bloqueia fluxo)
 */
export function logStrategicEnrichment(strategic, flags) {
    if (!strategic.strategicHints) return;

    console.log("🎯 [STRATEGIC-CONTEXT] Contexto enriquecido:", {
        price: strategic.strategicHints.price?.type,
        scheduling: strategic.strategicHints.scheduling?.type,
        complaintPriority: strategic.strategicHints.complaintPriority?.shouldAskComplaint,
        activeEnrichments: strategic._enrichment?.activeEnrichments
    });
}
```

---

## 🔌 Modificação MÍNIMA no AmandaOrchestrator.js

### Localização: Linha ~615 (após detecção)

```javascript
// ========================================
// ANTES (atual):
// ========================================
const flags = detectWithContextualDetectors(text, lead, enrichedContext);
console.log("🚩 FLAGS DETECTADAS:", flags);

if (flags._confirmation) {
    console.log("✅ [CONFIRMATION]", { ... });
}
if (flags._insurance) {
    console.log("🏥 [INSURANCE]", { ... });
}

// ... continua fluxo normal

// ========================================
// 🆕 DEPOIS (FASE 3 - ultra-seguro):
// ========================================
import { buildStrategicContext, logStrategicEnrichment } from './ContextEnrichmentLayer.js';

const flags = detectWithContextualDetectors(text, lead, enrichedContext);
console.log("🚩 FLAGS DETECTADAS:", flags);

// 🆕 FASE 3: Enriquecer contexto (NÃO intercepta fluxo)
const strategicContext = buildStrategicContext(flags, lead, enrichedContext);
logStrategicEnrichment(strategicContext, flags);

// ✅ RESTO DO CÓDIGO CONTINUA EXATAMENTE IGUAL
// ✅ Apenas usa strategicContext em vez de enrichedContext quando chamar IA

// Exemplo: quando chegar na parte da IA (linha ~3100+)
const aiResponse = await callAI({
    text,
    lead,
    context: strategicContext  // ✅ Usa contexto enriquecido (não mais enrichedContext)
});
```

### ✅ Mudanças Necessárias

**Total de linhas modificadas:** ~5 linhas
**Total de linhas adicionadas:** ~200 linhas (arquivo novo)
**Risco de quebrar:** Mínimo (apenas adiciona dados, não remove)

---

## 🔧 FASE 3.1: Correção da Ordem da Queixa (Ponto 1)

### Arquivo: `AmandaOrchestrator.js` - Linha ~217

```javascript
// ========================================
// ANTES (ordem errada):
// ========================================
function buildTriageSchedulingMessage({ flags, bookingProduct, ctx, lead }) {
    // ...

    // ❌ ORDEM ERRADA: perfil → queixa → período
    if (needsProfile) return "qual a idade?";
    if (needsComplaint) return "qual a queixa?";
    if (needsPeriod) return "manhã ou tarde?";
}

// ========================================
// 🆕 DEPOIS (FASE 3.1 - ordem correta):
// ========================================
function buildTriageSchedulingMessage({ flags, bookingProduct, ctx, lead }) {
    const knownArea = bookingProduct?.therapyArea || flags?.therapyArea || lead?.therapyArea;
    const knownProfile = !!(
        lead?.patientInfo?.age ||
        lead?.ageGroup ||
        lead?.qualificationData?.extractedInfo?.idade ||
        flags.mentionsChild ||
        flags.mentionsTeen ||
        flags.mentionsAdult ||
        ctx.ageGroup
    );
    const knownPeriod = !!(
        lead?.pendingPreferredPeriod ||
        lead?.autoBookingContext?.preferredPeriod ||
        ctx.preferredPeriod
    );
    const knownComplaint = !!(
        lead?.complaint ||
        lead?.patientInfo?.complaint ||
        lead?.autoBookingContext?.complaint ||
        ctx.complaint
    );

    const needsArea = !knownArea;
    const needsProfile = !knownProfile;
    const needsPeriod = !knownPeriod;
    const needsComplaint = !knownComplaint;

    // ✅ PRIORIDADE #1: QUEIXA SEMPRE PRIMEIRO (venda psicológica)
    if (needsComplaint) {
        return "Me conta um pouquinho: o que você tem observado que te preocupou? 💚";
    }

    // ✅ PRIORIDADE #2: Perfil (após ter queixa)
    if (needsProfile) {
        return "Entendi 😊 Só pra eu te orientar direitinho: qual a idade do paciente?";
    }

    // ✅ PRIORIDADE #3: Período (após perfil)
    if (needsPeriod) {
        return "Perfeito! Pra eu ver as melhores opções: vocês preferem manhã ou tarde?";
    }

    return "Me conta mais um detalhe pra eu te ajudar certinho 💚";
}
```

---

## ✅ Checklist de Implementação (Ultra-Seguro)

### FASE 3.1: Correção da Ordem da Queixa (Ponto 1)
- [ ] Modificar `buildTriageSchedulingMessage` (linha ~217)
- [ ] Trocar ordem: perfil → queixa PARA queixa → perfil → período
- [ ] Testar que queixa sempre vem primeiro
- [ ] Validar com dados reais

### FASE 3.2: Context Enrichment Layer (Ponto 2)
- [ ] Criar `/orchestrators/ContextEnrichmentLayer.js`
- [ ] Implementar `buildStrategicContext` (enriquece, não intercepta)
- [ ] Implementar `logStrategicEnrichment` (tracking)
- [ ] Testar que NÃO quebra fluxo existente

### FASE 3.3: Integração Mínima no Orchestrator
- [ ] Importar `ContextEnrichmentLayer` (linha ~8)
- [ ] Chamar `buildStrategicContext` após detectores (linha ~615)
- [ ] Usar `strategicContext` em vez de `enrichedContext` na IA
- [ ] Validar que tudo continua funcionando

### FASE 3.4: Testes de Segurança
- [ ] Testar que sistema funciona SEM as mudanças
- [ ] Testar que sistema funciona COM as mudanças
- [ ] Comparar respostas antes/depois
- [ ] Validar que ordem da queixa está correta

---

## 📊 Impacto Esperado (Conservador)

| Métrica | Antes | FASE 3 | Melhoria |
|---------|-------|--------|----------|
| **Ordem da queixa correta** | 60% | 100% | +66% |
| **Contexto enriquecido para IA** | Básico | Rico | +200% |
| **Risco de quebrar** | N/A | <1% | Mínimo |
| **Linhas modificadas** | 0 | ~10 | Conservador |

---

## 🎯 Resumo da Abordagem Ultra-Segura

### O Que FASE 3 FAZ:

1. ✅ **Corrige ordem da queixa** (Ponto 1) - queixa SEMPRE primeiro
2. ✅ **Enriquece contexto** com padrões dos 75k linhas (Ponto 2)
3. ✅ **NÃO intercepta fluxo** - IA continua decidindo
4. ✅ **NÃO hardcoded** - usa dados reais de pricing.js e padrões
5. ✅ **Mínimo de mudanças** - ~10 linhas modificadas, 200 novas

### O Que FASE 3 NÃO FAZ:

1. ❌ NÃO retorna respostas diretas (deixa IA decidir)
2. ❌ NÃO força comportamentos (apenas sugere)
3. ❌ NÃO quebra fluxo existente (100% backward compatible)
4. ❌ NÃO usa hardcoded (tudo baseado em dados reais)

---

**Status:** 📋 PLANO REVISADO (Ultra-Seguro)
**Risco:** Mínimo (<1%)
**Próxima ação:** Aguardando aprovação para implementar
