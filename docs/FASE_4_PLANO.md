# 🧠 FASE 4 - LEARNING LOOP PLANO
**Feedback Inteligente dos Detectores Contextuais**

---

## 🎯 Objetivo

Criar um **loop de aprendizado automático** que:
1. Rastreia efetividade dos detectores (FASE 1 + 2)
2. Ajusta confiança baseado em conversões reais
3. Identifica novos padrões automaticamente
4. Sugere melhorias nos detectores

### 🔍 Aproveitando Infraestrutura Existente

✅ **Já existe:** `LearningInsight` model (conversation patterns, objections)
✅ **Já existe:** `amandaLearningService.js` (análise de conversas)
✅ **Já existe:** `ContinuousLearningService.js` (learning contínuo)

🆕 **FASE 4 adiciona:** Tracking específico dos detectores contextuais

---

## 📊 O Que Vamos Rastrear

### 1. 💰 PriceDetector Effectiveness

**Métricas:**
```javascript
{
  detector: 'price',
  pattern: 'objection',          // tipo detectado
  detected: true,                 // detector ativou
  leadConverted: true,            // lead agendou?
  timeToConversion: 15,           // minutos até agendar
  contextAccuracy: 0.95,          // contexto estava correto?

  // Dados do lead
  leadId: '...',
  therapyArea: 'fonoaudiologia',
  stage: 'interessado_agendamento',

  // Dados da detecção
  confidence: 0.9,
  text: 'o preço tá muito caro',
  strategicHintUsed: 'value-focused'
}
```

### 2. 📅 SchedulingDetector Effectiveness

**Métricas:**
```javascript
{
  detector: 'scheduling',
  pattern: 'urgency',
  detected: true,
  urgencyMet: true,               // conseguiu atender urgência?
  slotsOffered: 3,                // quantos slots ofereceu
  slotAccepted: true,             // aceitou algum?
  preferredPeriodMatched: true,   // período preferido disponível?

  confidence: 1.0,
  text: 'preciso agendar urgente de manhã',
  strategicHintUsed: 'immediate_slots'
}
```

### 3. ✅ ConfirmationDetector Effectiveness

**Métricas:**
```javascript
{
  detector: 'confirmation',
  pattern: 'affirmative',
  detected: true,
  confirmationCorrect: true,      // interpretou corretamente?

  confidence: 0.85,
  text: 'sim, quero',
  semanticMeaning: 'affirmative'
}
```

### 4. 🏥 InsuranceDetector Effectiveness

**Métricas:**
```javascript
{
  detector: 'insurance',
  pattern: 'specific_plan',
  detected: true,
  planIdentified: 'unimed',
  wisdomKeyUsed: 'unimed_goiania',
  responseAccurate: true,

  confidence: 0.95,
  text: 'aceita unimed?'
}
```

---

## 🏗️ Arquitetura da FASE 4

### Componentes Novos

```
┌─────────────────────────────────────────┐
│   DetectorFeedbackTracker.js (novo)    │
│  - trackDetection()                     │
│  - recordOutcome()                      │
│  - calculateEffectiveness()             │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│   DetectorLearningService.js (novo)    │
│  - analyzeDetectorPerformance()         │
│  - adjustConfidenceThresholds()         │
│  - suggestNewPatterns()                 │
│  - generateDetectorInsights()           │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  LearningInsight Model (extender)       │
│  + detector_effectiveness (novo type)   │
└─────────────────────────────────────────┘
```

### Integração com Sistema Existente

```
AmandaOrchestrator
    ↓
detectWithContextualDetectors() → flags
    ↓
buildStrategicContext() → hints
    ↓
📝 trackDetection(flags, lead) ← FASE 4 (tracking)
    ↓
IA responde
    ↓
Lead agenda? (outcome)
    ↓
📊 recordOutcome(detectionId, outcome) ← FASE 4 (feedback)
    ↓
[Cron diário]
    ↓
analyzeDetectorPerformance() → insights
    ↓
adjustConfidenceThresholds() → novos thresholds
```

---

## 📝 Schema Extension - LearningInsight

### Adicionar novo tipo: `detector_effectiveness`

```javascript
const learningInsightSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: [
            "conversation_patterns",
            "successful_responses",
            "common_objections",
            "continuous_learning_cycle",
            "detector_effectiveness" // 🆕 FASE 4
        ],
        required: true,
    },

    // 🆕 FASE 4: Dados de efetividade dos detectores
    detectorData: {
        detector: String, // 'price', 'scheduling', 'confirmation', 'insurance'

        // Métricas agregadas
        totalDetections: Number,
        truePositives: Number,
        falsePositives: Number,
        trueNegatives: Number,
        falseNegatives: Number,

        // Efetividade por padrão
        patternEffectiveness: [{
            pattern: String, // 'objection', 'urgency', 'insistence', etc
            detections: Number,
            conversions: Number,
            conversionRate: Number,
            avgConfidence: Number,
            avgTimeToConversion: Number, // minutos

            // Sugestão de ajuste
            suggestedConfidenceThreshold: Number,
            needsReview: Boolean
        }],

        // Novos padrões descobertos
        discoveredPatterns: [{
            text: String,
            frequency: Number,
            associatedWithConversion: Boolean,
            suggestedPattern: String, // regex sugerido
            verified: { type: Boolean, default: false } // 🔒 Human in the loop
        }],

        // Recomendações
        recommendations: [{
            type: String, // 'adjust_confidence', 'add_pattern', 'remove_pattern'
            pattern: String,
            currentValue: mongoose.Schema.Types.Mixed,
            suggestedValue: mongoose.Schema.Types.Mixed,
            reason: String,
            impact: String // 'high', 'medium', 'low'
        }]
    },

    // ... resto do schema existente
});
```

---

## 🔧 Implementação

### Arquivo 1: `/models/DetectorFeedback.js` (novo)

**Modelo para rastrear cada detecção individual**

```javascript
import mongoose from 'mongoose';

const detectorFeedbackSchema = new mongoose.Schema({
    // Identificação
    detector: {
        type: String,
        enum: ['price', 'scheduling', 'confirmation', 'insurance'],
        required: true
    },

    pattern: String, // tipo específico detectado

    // Dados da detecção
    text: String,
    confidence: Number,
    detectedAt: { type: Date, default: Date.now },

    // Contexto
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    therapyArea: String,
    stage: String,

    // Strategic hint que foi usado
    strategicHintUsed: String,

    // Outcome (preenchido depois)
    outcome: {
        recorded: { type: Boolean, default: false },
        leadConverted: Boolean,
        timeToConversion: Number, // minutos
        contextWasCorrect: Boolean,
        detectionWasUseful: Boolean,

        // Específico por detector
        specificMetrics: mongoose.Schema.Types.Mixed,

        recordedAt: Date
    }
}, { timestamps: true });

// Índices para queries rápidas
detectorFeedbackSchema.index({ detector: 1, pattern: 1, createdAt: -1 });
detectorFeedbackSchema.index({ lead: 1 });
detectorFeedbackSchema.index({ 'outcome.recorded': 1, createdAt: -1 });

export default mongoose.models.DetectorFeedback ||
    mongoose.model('DetectorFeedback', detectorFeedbackSchema);
```

### Arquivo 2: `/services/DetectorFeedbackTracker.js` (novo)

**Service para rastrear detecções e resultados**

```javascript
import DetectorFeedback from '../models/DetectorFeedback.js';
import Leads from '../models/Leads.js';

/**
 * 📝 Registra uma detecção do detector contextual
 *
 * Chamado logo após detectWithContextualDetectors()
 */
export async function trackDetection({
    detector,           // 'price', 'scheduling', etc
    pattern,            // 'objection', 'urgency', etc
    text,
    confidence,
    lead,
    message,
    strategicHintUsed   // qual hint foi aplicado
}) {
    try {
        const feedback = await DetectorFeedback.create({
            detector,
            pattern,
            text,
            confidence,
            lead: lead._id,
            message: message?._id,
            therapyArea: lead.therapyArea,
            stage: lead.stage,
            strategicHintUsed
        });

        console.log(`📝 [DETECTOR-FEEDBACK] Tracked ${detector}:${pattern} (confidence: ${confidence})`);

        return feedback._id;
    } catch (err) {
        console.error('[DETECTOR-FEEDBACK] Error tracking:', err.message);
        return null;
    }
}

/**
 * 📊 Registra o resultado de uma detecção
 *
 * Chamado quando:
 * - Lead agenda (conversão)
 * - Lead responde negativamente
 * - Timeout (sem resposta)
 */
export async function recordOutcome({
    leadId,
    converted = false,
    timeToConversion = 0,
    specificMetrics = {}
}) {
    try {
        // Busca todas as detecções deste lead que ainda não têm outcome
        const pendingFeedbacks = await DetectorFeedback.find({
            lead: leadId,
            'outcome.recorded': false
        });

        if (pendingFeedbacks.length === 0) {
            return { updated: 0 };
        }

        const updates = await Promise.all(
            pendingFeedbacks.map(async (feedback) => {
                feedback.outcome = {
                    recorded: true,
                    leadConverted: converted,
                    timeToConversion,
                    contextWasCorrect: await validateContext(feedback),
                    detectionWasUseful: converted, // simplificado
                    specificMetrics,
                    recordedAt: new Date()
                };

                return feedback.save();
            })
        );

        console.log(`📊 [DETECTOR-FEEDBACK] Recorded outcome for ${updates.length} detections (converted: ${converted})`);

        return { updated: updates.length };
    } catch (err) {
        console.error('[DETECTOR-FEEDBACK] Error recording outcome:', err.message);
        return { updated: 0, error: err.message };
    }
}

/**
 * ✅ Valida se o contexto estava correto
 *
 * Verifica se a detecção foi precisa baseado no comportamento subsequente
 */
async function validateContext(feedback) {
    // TODO: Implementar validação específica por detector
    // Por enquanto, assume que detecções com confidence > 0.8 são corretas
    return feedback.confidence > 0.8;
}

/**
 * 📈 Calcula efetividade de um detector específico
 */
export async function calculateDetectorEffectiveness(detector, pattern = null, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const query = {
        detector,
        'outcome.recorded': true,
        createdAt: { $gte: since }
    };

    if (pattern) {
        query.pattern = pattern;
    }

    const feedbacks = await DetectorFeedback.find(query);

    if (feedbacks.length === 0) {
        return {
            detector,
            pattern,
            totalDetections: 0,
            noData: true
        };
    }

    const converted = feedbacks.filter(f => f.outcome.leadConverted);
    const avgConfidence = feedbacks.reduce((sum, f) => sum + f.confidence, 0) / feedbacks.length;
    const avgTimeToConversion = converted.length > 0
        ? converted.reduce((sum, f) => sum + (f.outcome.timeToConversion || 0), 0) / converted.length
        : 0;

    return {
        detector,
        pattern,
        totalDetections: feedbacks.length,
        conversions: converted.length,
        conversionRate: (converted.length / feedbacks.length) * 100,
        avgConfidence: Math.round(avgConfidence * 100) / 100,
        avgTimeToConversion: Math.round(avgTimeToConversion),

        // Detalhes
        truePositives: converted.filter(f => f.outcome.contextWasCorrect).length,
        falsePositives: feedbacks.filter(f => !f.outcome.leadConverted && f.outcome.detectionWasUseful === false).length
    };
}
```

### Arquivo 3: `/services/DetectorLearningService.js` (novo)

**Service para análise e aprendizado automático**

```javascript
import DetectorFeedback from '../models/DetectorFeedback.js';
import LearningInsight from '../models/LearningInsight.js';
import { calculateDetectorEffectiveness } from './DetectorFeedbackTracker.js';

/**
 * 🧠 Analisa performance de todos os detectores
 *
 * Roda diariamente via cron
 */
export async function analyzeAllDetectors(days = 30) {
    console.log(`🧠 [DETECTOR-LEARNING] Analyzing detector performance (last ${days} days)...`);

    const detectors = ['price', 'scheduling', 'confirmation', 'insurance'];
    const results = [];

    for (const detector of detectors) {
        const analysis = await analyzeDetector(detector, days);
        results.push(analysis);
    }

    // Salva insights
    const insight = await LearningInsight.create({
        type: 'detector_effectiveness',
        detectorData: {
            analyzedAt: new Date(),
            period: `${days} days`,
            detectors: results
        },
        generatedAt: new Date()
    });

    console.log(`✅ [DETECTOR-LEARNING] Analysis complete. Insight ID: ${insight._id}`);

    return results;
}

/**
 * 🔍 Analisa um detector específico
 */
async function analyzeDetector(detector, days) {
    // Busca patterns únicos deste detector
    const patterns = await DetectorFeedback.distinct('pattern', {
        detector,
        createdAt: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
    });

    const patternAnalysis = [];

    for (const pattern of patterns) {
        const effectiveness = await calculateDetectorEffectiveness(detector, pattern, days);

        if (!effectiveness.noData) {
            // Sugestão de ajuste de confiança
            const suggestedThreshold = calculateSuggestedThreshold(effectiveness);

            patternAnalysis.push({
                pattern,
                ...effectiveness,
                suggestedConfidenceThreshold: suggestedThreshold,
                needsReview: effectiveness.conversionRate < 30 || effectiveness.falsePositives > 10
            });
        }
    }

    // Busca novos padrões (textos frequentes que levaram a conversão)
    const discoveredPatterns = await discoverNewPatterns(detector, days);

    return {
        detector,
        patterns: patternAnalysis,
        discoveredPatterns,
        recommendations: generateRecommendations(patternAnalysis, discoveredPatterns)
    };
}

/**
 * 🎯 Calcula threshold de confiança sugerido baseado em performance
 */
function calculateSuggestedThreshold(effectiveness) {
    const { conversionRate, avgConfidence, truePositives, falsePositives } = effectiveness;

    // Se conversionRate > 70% e falsePositives baixo, pode baixar threshold
    if (conversionRate > 70 && falsePositives < 5) {
        return Math.max(0.6, avgConfidence - 0.1);
    }

    // Se conversionRate < 40% ou muitos falsePositives, aumentar threshold
    if (conversionRate < 40 || falsePositives > 10) {
        return Math.min(0.95, avgConfidence + 0.15);
    }

    // Mantém threshold atual
    return avgConfidence;
}

/**
 * 🔎 Descobre novos padrões que levam a conversão
 */
async function discoverNewPatterns(detector, days) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Busca textos que levaram a conversão mas com baixa confidence
    const lowConfidenceConversions = await DetectorFeedback.find({
        detector,
        createdAt: { $gte: since },
        confidence: { $lt: 0.7 },
        'outcome.recorded': true,
        'outcome.leadConverted': true
    }).limit(50);

    // Agrupa textos similares
    const textFrequency = {};

    lowConfidenceConversions.forEach(feedback => {
        const normalized = feedback.text.toLowerCase().trim();
        const words = normalized.split(/\s+/).filter(w => w.length > 3);

        words.forEach(word => {
            if (!textFrequency[word]) {
                textFrequency[word] = { count: 0, examples: [] };
            }
            textFrequency[word].count++;
            if (textFrequency[word].examples.length < 3) {
                textFrequency[word].examples.push(feedback.text);
            }
        });
    });

    // Retorna palavras frequentes (potenciais novos padrões)
    return Object.entries(textFrequency)
        .filter(([word, data]) => data.count >= 3)
        .map(([word, data]) => ({
            keyword: word,
            frequency: data.count,
            examples: data.examples,
            suggestedPattern: `\\b${word}\\b`,
            verified: false // 🔒 Precisa aprovação humana
        }))
        .slice(0, 10);
}

/**
 * 💡 Gera recomendações baseadas na análise
 */
function generateRecommendations(patternAnalysis, discoveredPatterns) {
    const recommendations = [];

    // Recomendações por padrão
    patternAnalysis.forEach(analysis => {
        if (analysis.needsReview) {
            recommendations.push({
                type: 'review_pattern',
                pattern: analysis.pattern,
                reason: `Low conversion rate (${analysis.conversionRate.toFixed(1)}%) or high false positives`,
                impact: 'high'
            });
        }

        if (Math.abs(analysis.suggestedConfidenceThreshold - analysis.avgConfidence) > 0.1) {
            recommendations.push({
                type: 'adjust_confidence',
                pattern: analysis.pattern,
                currentValue: analysis.avgConfidence,
                suggestedValue: analysis.suggestedConfidenceThreshold,
                reason: `Performance suggests threshold adjustment`,
                impact: 'medium'
            });
        }
    });

    // Recomendações de novos padrões
    discoveredPatterns.forEach(pattern => {
        if (pattern.frequency >= 5) {
            recommendations.push({
                type: 'add_pattern',
                pattern: pattern.keyword,
                suggestedValue: pattern.suggestedPattern,
                reason: `Frequent pattern in converted leads (${pattern.frequency} occurrences)`,
                impact: 'medium',
                examples: pattern.examples
            });
        }
    });

    return recommendations;
}

/**
 * 📊 Exporta relatório de learning para revisão humana
 */
export async function exportLearningReport(days = 30) {
    const analysis = await analyzeAllDetectors(days);

    const report = {
        generatedAt: new Date().toISOString(),
        period: `${days} days`,
        summary: {
            totalDetectors: analysis.length,
            totalRecommendations: analysis.reduce((sum, d) => sum + d.recommendations.length, 0),
            highImpact: analysis.reduce((sum, d) =>
                sum + d.recommendations.filter(r => r.impact === 'high').length, 0
            )
        },
        detectors: analysis
    };

    return report;
}
```

---

## 🔌 Integração no AmandaOrchestrator.js

### Onde adicionar tracking (linha ~658, após strategicContext)

```javascript
// 🆕 FASE 3: ENRIQUECIMENTO ESTRATÉGICO DO CONTEXTO
const strategicEnhancements = buildStrategicContext(flags, lead, enrichedContext);
enrichedContext.strategicHints = strategicEnhancements.strategicHints;
enrichedContext._enrichment = strategicEnhancements._enrichment;
logStrategicEnrichment(enrichedContext, flags);

// 🆕 FASE 4: TRACKING DE DETECÇÕES (Learning Loop)
if (flags._price?.detected) {
    trackDetection({
        detector: 'price',
        pattern: flags._price.priceType,
        text,
        confidence: flags._price.confidence,
        lead,
        message: messageId,
        strategicHintUsed: enrichedContext.strategicHints.price?.suggestions.tone
    }).catch(err => console.error('[FASE4] Track error:', err));
}

if (flags._scheduling?.detected) {
    trackDetection({
        detector: 'scheduling',
        pattern: flags._scheduling.schedulingType,
        text,
        confidence: flags._scheduling.confidence,
        lead,
        message: messageId,
        strategicHintUsed: enrichedContext.strategicHints.scheduling?.suggestions.priority
    }).catch(err => console.error('[FASE4] Track error:', err));
}

// Similar para _confirmation e _insurance...
```

### Onde registrar outcome (quando lead agenda)

```javascript
// Exemplo: quando autoBookAppointment() tem sucesso
if (bookingResult.success) {
    await safeLeadUpdate(lead._id, {
        $set: {
            status: "agendado",
            // ...
        }
    });

    // 🆕 FASE 4: Registra que lead converteu
    await recordOutcome({
        leadId: lead._id,
        converted: true,
        timeToConversion: calculateTimeToConversion(lead),
        specificMetrics: {
            bookingType: bookingResult.type,
            slot: bookingResult.slot
        }
    }).catch(err => console.error('[FASE4] Outcome error:', err));

    return ensureSingleHeart(...);
}
```

---

## 🕐 Cron Job Diário

### `/crons/detectorLearningCron.js` (novo)

```javascript
import cron from 'node-cron';
import { analyzeAllDetectors, exportLearningReport } from '../services/DetectorLearningService.js';

// Roda todo dia às 3am
cron.schedule('0 3 * * *', async () => {
    console.log('🧠 [CRON] Starting detector learning analysis...');

    try {
        const report = await exportLearningReport(30);

        console.log('📊 [CRON] Detector Learning Report:');
        console.log(`  - Total recommendations: ${report.summary.totalRecommendations}`);
        console.log(`  - High impact: ${report.summary.highImpact}`);

        // TODO: Enviar relatório por email ou notificação

    } catch (err) {
        console.error('❌ [CRON] Detector learning error:', err);
    }
});

console.log('✅ Detector Learning Cron scheduled (3am daily)');
```

---

## ✅ Checklist de Implementação FASE 4

### 4.1: Models & Schema
- [ ] Criar `DetectorFeedback.js` model
- [ ] Estender `LearningInsight` com type `detector_effectiveness`
- [ ] Testar schemas no MongoDB

### 4.2: Services
- [ ] Criar `DetectorFeedbackTracker.js`
  - [ ] `trackDetection()`
  - [ ] `recordOutcome()`
  - [ ] `calculateDetectorEffectiveness()`
- [ ] Criar `DetectorLearningService.js`
  - [ ] `analyzeAllDetectors()`
  - [ ] `discoverNewPatterns()`
  - [ ] `generateRecommendations()`
  - [ ] `exportLearningReport()`

### 4.3: Integration
- [ ] Adicionar tracking calls no AmandaOrchestrator (após detectores)
- [ ] Adicionar outcome recording (quando lead agenda)
- [ ] Criar cron job diário

### 4.4: Testing
- [ ] Testar tracking de detecções
- [ ] Testar recording de outcomes
- [ ] Validar análise de performance
- [ ] Verificar recomendações geradas

---

## 📊 Impacto Esperado

| Métrica | Sem FASE 4 | Com FASE 4 | Melhoria |
|---------|------------|------------|----------|
| **Precision dos detectores** | 70-80% | 85-95% | +15-20% |
| **Novos padrões descobertos** | 0/mês | 5-10/mês | +infinito |
| **Ajustes baseados em dados** | Manual | Automático | 100% |
| **Tempo para identificar problemas** | Semanas | 1 dia | -95% |

---

## 🎯 Próximos Passos

1. ✅ Aprovar plano FASE 4
2. ⏳ Implementar models
3. ⏳ Implementar services
4. ⏳ Integrar no Orchestrator
5. ⏳ Criar cron job
6. ⏳ Testar e validar

---

**Status:** 📋 PLANEJAMENTO
**Próxima ação:** Aguardando aprovação para implementar
