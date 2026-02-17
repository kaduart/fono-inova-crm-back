// services/DetectorLearningService.js
// 🎯 FASE 4: Análise de efetividade dos detectores
// ✅ INTEGRA com infraestrutura existente (ContinuousLearningService)

import DetectorFeedback from '../models/DetectorFeedback.js';
import { calculateDetectorEffectiveness, findLowConfidenceConversions } from './DetectorFeedbackTracker.js';

// ✅ INTEGRA com padrões existentes do PatternRecognitionService
// 🆕 ATUALIZADO em 2026-02-16: Após unificação com detectores estendidos
const DETECTOR_TO_EXISTING_PATTERNS = {
    price: {
        // 🆕 PriceDetector.isEarlyQuestion absorve early_price_question
        earlyQuestion: 'early_price_question',   // DEPRECATED - agora em PriceDetector.isEarlyQuestion
        insistence: 'early_price_question',      // DEPRECATED - mesma funcionalidade
        objection: 'silence_after_price'         // Ainda ativo (complementar)
    },
    scheduling: {
        // 🆕 SchedulingDetector já tinha cancellation desde FASE 2
        cancellation: 'cancellation',            // DEPRECATED - 95%+ duplicação
        urgency: null,                           // Novo padrão (detector-only)
        reschedule: null                         // Novo padrão (detector-only)
    },
    confirmation: {
        insistence: null                         // Novo padrão (detector-only)
    },
    insurance: {
        // 🆕 InsuranceDetector.intentType='confusion' absorve insurance_confusion
        confusion: 'insurance_confusion'         // DEPRECATED - agora em InsuranceDetector.isConfused
    }
};

/**
 * 📊 Analisa efetividade de todos os detectores
 *
 * Chamado pelo ContinuousLearningService.runLearningCycle()
 * como Step 8
 */
export async function analyzeDetectorPerformance(days = 30) {
    console.log(`\n📊 [DETECTOR-LEARNING] Analyzing detector performance (${days} days)`);

    const detectors = ['price', 'scheduling', 'confirmation', 'insurance'];
    const analysis = {
        generatedAt: new Date(),
        period: `${days} days`,
        detectors: {}
    };

    for (const detector of detectors) {
        const stats = await calculateDetectorEffectiveness(detector, null, days);

        // Analisa padrões específicos
        const patterns = await analyzeDetectorPatterns(detector, days);

        // Recomendações de ajuste
        const recommendations = generateRecommendations(detector, stats, patterns);

        analysis.detectors[detector] = {
            overall: stats,
            patterns,
            recommendations
        };

        console.log(`  ✓ ${detector}: ${stats.totalDetections} detections, ${stats.conversionRate}% conversion`);
    }

    // Descobre novos padrões de baixa confiança que converteram
    const newPatterns = await discoverNewPatterns(days);
    analysis.newPatternsDiscovered = newPatterns;

    return analysis;
}

/**
 * 🔍 Analisa padrões específicos de um detector
 */
async function analyzeDetectorPatterns(detector, days) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Busca todos os padrões distintos para este detector
    const patterns = await DetectorFeedback.distinct('pattern', {
        detector,
        'outcome.recorded': true,
        createdAt: { $gte: since }
    });

    const results = [];

    for (const pattern of patterns) {
        const stats = await calculateDetectorEffectiveness(detector, pattern, days);

        // Verifica se existe padrão equivalente no sistema antigo
        const existingPattern = DETECTOR_TO_EXISTING_PATTERNS[detector]?.[pattern];

        results.push({
            pattern,
            ...stats,
            existingPattern,
            shouldRetire: existingPattern ? stats.conversionRate < 5 : false // Se já existe e não converte, deprecar
        });
    }

    return results;
}

/**
 * 💡 Gera recomendações baseadas nos dados
 */
function generateRecommendations(detector, overall, patterns) {
    const recommendations = [];

    // Recomendação 1: Ajuste de threshold de confiança
    if (overall.totalDetections > 50) {
        if (overall.precision < 70) {
            recommendations.push({
                type: 'threshold_adjustment',
                action: 'increase',
                current: 'confidence > 0.7',
                suggested: 'confidence > 0.8',
                reason: `Precisão baixa (${overall.precision}%). Aumentar threshold reduz falsos positivos.`
            });
        } else if (overall.precision > 90 && overall.totalDetections < 100) {
            recommendations.push({
                type: 'threshold_adjustment',
                action: 'decrease',
                current: 'confidence > 0.7',
                suggested: 'confidence > 0.6',
                reason: `Precisão alta (${overall.precision}%) mas poucas detecções. Reduzir threshold captura mais casos.`
            });
        }
    }

    // Recomendação 2: Padrões para deprecar
    const lowPerformers = patterns.filter(p =>
        p.totalDetections > 10 &&
        p.conversionRate < 5 &&
        !p.existingPattern // Não deprecar se é integração com padrão existente
    );

    if (lowPerformers.length > 0) {
        recommendations.push({
            type: 'deprecate_patterns',
            patterns: lowPerformers.map(p => p.pattern),
            reason: `Padrões com <5% conversão após ${lowPerformers[0].totalDetections}+ detecções.`
        });
    }

    // Recomendação 3: Integração com padrões existentes
    const shouldIntegrate = patterns.filter(p =>
        p.existingPattern &&
        p.conversionRate > 10
    );

    if (shouldIntegrate.length > 0) {
        recommendations.push({
            type: 'integrate_with_existing',
            patterns: shouldIntegrate.map(p => ({
                detector: `${detector}:${p.pattern}`,
                existingPattern: p.existingPattern,
                conversionRate: p.conversionRate
            })),
            reason: 'Detector tem overlap com padrões existentes e performance boa. Unificar lógica.'
        });
    }

    // Recomendação 4: Novos padrões promissores
    const promising = patterns.filter(p =>
        !p.existingPattern &&
        p.totalDetections > 20 &&
        p.conversionRate > 15 &&
        p.precision > 75
    );

    if (promising.length > 0) {
        recommendations.push({
            type: 'promote_to_known_patterns',
            patterns: promising.map(p => ({
                pattern: p.pattern,
                stats: {
                    conversions: p.conversions,
                    rate: p.conversionRate,
                    precision: p.precision
                }
            })),
            reason: 'Padrões novos com alta conversão e precisão. Considerar adicionar a KNOWN_PROBLEM_PATTERNS.'
        });
    }

    return recommendations;
}

/**
 * 🔎 Descobre novos padrões de baixa confiança que converteram
 *
 * Estes são oportunidades de melhorar os detectores
 */
async function discoverNewPatterns(days) {
    console.log(`\n🔎 [DETECTOR-LEARNING] Discovering new patterns...`);

    const detectors = ['price', 'scheduling', 'confirmation', 'insurance'];
    const discoveries = [];

    for (const detector of detectors) {
        // Busca conversões de baixa confiança (0.5 - 0.7)
        const lowConfidence = await findLowConfidenceConversions(detector, days, 0.7);

        if (lowConfidence.length > 0) {
            // Agrupa por padrão similar (análise simples de texto)
            const grouped = groupSimilarTexts(lowConfidence);

            for (const group of grouped) {
                if (group.texts.length >= 3) { // Pelo menos 3 exemplos
                    discoveries.push({
                        detector,
                        patternCandidate: group.commonWords.slice(0, 3).join(' + '),
                        examples: group.texts.slice(0, 5),
                        frequency: group.texts.length,
                        avgConfidence: group.avgConfidence,
                        allConverted: true,
                        suggestion: `Adicionar palavras-chave: ${group.commonWords.join(', ')}`
                    });
                }
            }
        }
    }

    console.log(`  ✓ Found ${discoveries.length} pattern candidates`);

    return discoveries;
}

/**
 * 📝 Agrupa textos similares para descobrir padrões
 *
 * Análise simplificada: busca palavras-chave comuns
 */
function groupSimilarTexts(feedbacks) {
    const groups = [];

    // Extrai palavras-chave de cada texto (>3 letras, não stopwords)
    const STOPWORDS = ['que', 'para', 'com', 'uma', 'por', 'mais', 'mas', 'como', 'seu', 'sua'];

    const textsWithKeywords = feedbacks.map(f => ({
        text: f.text,
        confidence: f.confidence,
        keywords: f.text
            .toLowerCase()
            .replace(/[^\w\sáàâãéêíóôõúç]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 3 && !STOPWORDS.includes(w))
    }));

    // Agrupa textos com palavras-chave em comum
    for (const item of textsWithKeywords) {
        let foundGroup = false;

        for (const group of groups) {
            // Verifica overlap de keywords
            const commonKeywords = item.keywords.filter(k =>
                group.commonWords.includes(k)
            );

            if (commonKeywords.length >= 2) {
                group.texts.push(item.text);
                group.confidences.push(item.confidence);
                foundGroup = true;
                break;
            }
        }

        if (!foundGroup && item.keywords.length > 0) {
            groups.push({
                commonWords: item.keywords,
                texts: [item.text],
                confidences: [item.confidence],
                avgConfidence: item.confidence
            });
        }
    }

    // Calcula média de confiança
    groups.forEach(g => {
        g.avgConfidence = g.confidences.reduce((a, b) => a + b, 0) / g.confidences.length;
    });

    return groups.filter(g => g.texts.length >= 2);
}

/**
 * 🔗 Mapeia detecção para padrão existente (se houver)
 *
 * Usado para unificar sugestões entre detector novo e padrão antigo
 */
export function mapToExistingPattern(detector, pattern) {
    return DETECTOR_TO_EXISTING_PATTERNS[detector]?.[pattern] || null;
}

/**
 * 📋 Gera relatório resumido para log
 */
export function generateAnalysisReport(analysis) {
    const lines = [
        '\n═══════════════════════════════════════════════════',
        '📊 DETECTOR PERFORMANCE ANALYSIS',
        `📅 Period: ${analysis.period}`,
        '═══════════════════════════════════════════════════'
    ];

    for (const [detector, data] of Object.entries(analysis.detectors)) {
        lines.push(`\n🔍 ${detector.toUpperCase()}`);
        lines.push(`   Detections: ${data.overall.totalDetections}`);
        lines.push(`   Conversions: ${data.overall.conversions} (${data.overall.conversionRate}%)`);
        lines.push(`   Precision: ${data.overall.precision}%`);
        lines.push(`   Avg Time to Conversion: ${data.overall.avgTimeToConversion}min`);

        if (data.recommendations.length > 0) {
            lines.push(`   💡 Recommendations: ${data.recommendations.length}`);
            data.recommendations.forEach(r => {
                lines.push(`      - ${r.type}: ${r.reason}`);
            });
        }
    }

    if (analysis.newPatternsDiscovered?.length > 0) {
        lines.push(`\n🔎 NEW PATTERNS DISCOVERED: ${analysis.newPatternsDiscovered.length}`);
        analysis.newPatternsDiscovered.forEach(p => {
            lines.push(`   - ${p.detector}: "${p.patternCandidate}" (${p.frequency}x, ${Math.round(p.avgConfidence * 100)}% conf)`);
        });
    }

    lines.push('═══════════════════════════════════════════════════\n');

    return lines.join('\n');
}

export default {
    analyzeDetectorPerformance,
    mapToExistingPattern,
    generateAnalysisReport
};
