/**
 * 📊 AmandaMetrics — Observabilidade sem intrusão
 * 
 * Não mexe na arquitetura.
 * Apenas observa e mede.
 * 
 * Uso: Plug no run-94-scenarios.js existente
 */

export class AmandaMetrics {
    constructor() {
        this.reset();
    }

    reset() {
        this.interactions = [];
        this.summary = {
            total: 0,
            passed: 0,
            failed: 0,
            byCategory: {}
        };
    }

    /**
     * Analisa uma interação completa
     * Não altera comportamento, apenas observa
     */
    analyze({ scenario, input, output, context = {} }) {
        const analysis = {
            id: scenario.id,
            category: scenario.category,
            input: typeof input === 'string' ? input.substring(0, 100) : '',
            output: typeof output === 'string' ? output.substring(0, 200) : '',

            timestamp: new Date().toISOString(),

            // Métricas comportamentais (contrato, não frase)
            metrics: {
                // 1. Respondeu à pergunta?
                answeredQuestion: this.checkAnsweredQuestion(input, output),

                // 2. Manteve continuidade?
                continuity: this.checkContinuity(context, output),

                // 3. Teve CTA apropriado?
                cta: this.checkCTA(context, output),

                // 4. Contextualizou preço (se aplicável)?
                priceContext: context.flags?.asksPrice
                    ? this.checkPriceContext(output)
                    : 'n/a',

                // 5. Mencionou dados do paciente?
                personalization: this.checkPersonalization(context, output),

                // 6. Tom adequado ao modo?
                tone: this.checkTone(context, output),

                // 7. Regras de segurança?
                safety: this.checkSafety(output),

                schedulingStrategy: this.checkSchedulingStrategy(context, output),
                conversationProgress: this.checkConversationProgress(context, output),

            }
        };

        // Calcula score geral
        analysis.score = this.calculateScore(analysis.metrics);
        analysis.grade = this.scoreToGrade(analysis.score);

        this.interactions.push(analysis);
        this.updateSummary(analysis);

        return analysis;
    }

    // ============ CHECKS INDIVIDUAIS ============

    checkAnsweredQuestion(input, output) {
        // Heurística: se input tem pergunta direta, output deve ter resposta direta
        const isQuestion = /\b(qual|quanto|onde|quando|como|por que|vocês|tem|faz)\b.*\?/i.test(input);
        if (!isQuestion) return { passed: true, reason: 'n/a' };

        // Extrai keywords da pergunta (remove stopwords)
        const keywords = input.toLowerCase()
            .replace(/\b(qual|quanto|onde|quando|como|por que|vocês|o|a|os|as|de|da|do|em|um|uma)\b/g, '')
            .match(/\b\w{4,}\b/g) || [];

        // Pelo menos uma keyword deve aparecer na resposta
        const matched = keywords.filter(k => output.toLowerCase().includes(k));
        const passed = matched.length > 0 || output.length > 50; // Resposta substancial

        return {
            passed,
            reason: passed
                ? `keywords: ${matched.slice(0, 3).join(', ')}`
                : `nenhuma keyword [${keywords.slice(0, 3)}] encontrada`,
            confidence: matched.length / keywords.length
        };
    }

    checkContinuity(context, output) {
        // Se há histórico, deve referenciar ou continuar tópico
        if (!context.lastTopic) return { passed: true, reason: 'no prior topic' };

        const topicWords = context.lastTopic.toLowerCase().split(/\s+/);
        const referenced = topicWords.some(w =>
            w.length > 3 && output.toLowerCase().includes(w)
        );

        // Ou usa palavra de continuidade
        const continuityWords = /(então|sobre|quanto a|sobre isso|a propósito|falando em)/i.test(output);

        return {
            passed: referenced || continuityWords,
            reason: referenced ? 'referenced topic' : (continuityWords ? 'continuity word' : 'no reference'),
            lastTopic: context.lastTopic
        };
    }

    checkCTA(context, output) {
        // Só exige CTA em contextos de alta intenção
        const shouldHaveCTA = context.intentScore >= 40
            || context.flags?.wantsSchedule
            || context.stage === 'qualificado';

        if (!shouldHaveCTA) return { passed: true, reason: 'low intent, no CTA required' };

        const ctaPatterns = [
            /posso (garantir|verificar|agendar|marcar|reservar)/i,
            /quer (que eu|saber|agendar)/i,
            /vou te (mandar|enviar|passar|ligar)/i,
            /me (chama|avise|diga|confirma)/i,
            /fico (por aqui|no aguardo|esperando)/i,
            /qualquer (dúvida|coisa|coisinha)/i,
            /estou (aqui|disponível|por perto)/i
        ];

        const found = ctaPatterns.filter(p => p.test(output));

        return {
            passed: found.length > 0,
            reason: found.length > 0 ? `CTA found: ${found[0]}` : 'no CTA pattern',
            required: true
        };
    }

    checkPriceContext(output) {
        const hasPrice = /R\$\s*\d/.test(output);
        if (!hasPrice) return { passed: true, reason: 'no price mentioned' };

        const priceMatch = output.match(/R\$\s*\d+/);
        const priceIndex = output.indexOf(priceMatch[0]);
        const beforePrice = output.substring(0, priceIndex);

        const contextIndicators = [
            /investimento/i,
            /inclui/i,
            /avaliação/i,
            /anamnese/i,
            /sessão/i,
            /atendimento/i,
            /valor/i
        ];

        const hasContext = contextIndicators.some(p => p.test(beforePrice));

        return {
            passed: hasContext,
            reason: hasContext ? 'price contextualized' : 'price without context',
            price: priceMatch[0]
        };
    }

    checkPersonalization(context, output) {
        const checks = [];

        // Nome do paciente
        if (context.patientName) {
            checks.push({
                type: 'name',
                passed: output.includes(context.patientName),
                expected: context.patientName
            });
        }

        // Idade
        if (context.patientAge) {
            const ageMentioned = new RegExp(`\\b${context.patientAge}\\s*(anos?|a)\\b`, 'i').test(output);
            checks.push({
                type: 'age',
                passed: ageMentioned,
                expected: `${context.patientAge} anos`
            });
        }

        // Área terapêutica
        if (context.therapyArea) {
            const areaMentioned = output.toLowerCase().includes(context.therapyArea.toLowerCase());
            checks.push({
                type: 'therapy',
                passed: areaMentioned,
                expected: context.therapyArea
            });
        }

        const passed = checks.filter(c => c.passed).length;
        const total = checks.length;

        return {
            passed: total === 0 || passed >= total / 2, // Pelo menos metade
            reason: `${passed}/${total} personalization checks passed`,
            details: checks
        };
    }

    checkTone(context, output) {
        const mode = context.mode || 'NATURAL';

        const toneChecks = {
            'CLOSER': {
                required: /(posso garantir|tenho vaga|agendar agora|fechar|garantir)/i,
                forbidden: /(vou verificar|quando você|me avise|pense)/i
            },
            'ACOLHIMENTO': {
                required: /(entendo|faz sentido|preocupação|natural|comum|cuidado)/i,
                forbidden: /(promoção|aproveite|só hoje|desconto especial)/i
            },
            'URGENCIA': {
                required: /(rápido|prioridade|resolver|o mais breve|urgência)/i,
                forbidden: /(sem pressa|quando puder|depois|pense com calma)/i
            }
        };

        const check = toneChecks[mode];
        if (!check) return { passed: true, reason: 'no tone check for mode' };

        const hasRequired = check.required.test(output);
        const hasForbidden = check.forbidden.test(output);

        return {
            passed: hasRequired && !hasForbidden,
            reason: `required: ${hasRequired}, forbidden: ${hasForbidden}`,
            mode
        };
    }

    checkSafety(output) {
        const forbidden = [
            { pattern: /disponha/i, severity: 'critical' },
            { pattern: /à disposição/i, severity: 'critical' },
            { pattern: /estamos à disposição/i, severity: 'critical' },
            { pattern: /confirmo (segunda|terça|quarta|quinta|sexta|sábado|domingo) às \d{2}:\d{2}/i, severity: 'high' },
            { pattern: /tabela de preços/i, severity: 'medium' }
        ];

        const violations = forbidden.filter(f => f.pattern.test(output));

        return {
            passed: violations.length === 0,
            reason: violations.length === 0 ? 'no violations' : `violations: ${violations.map(v => v.pattern.source).join(', ')}`,
            violations
        };
    }

    // ============ SCORING ============

    calculateScore(metrics) {
        const weights = {
            answeredQuestion: 0.15,
            continuity: 0.10,
            cta: 0.15,
            priceContext: 0.10,
            personalization: 0.10,
            tone: 0.10,
            safety: 0.15,
            schedulingStrategy: 0.15,
            conversationProgress: 0.10
        };


        let score = 0;
        let totalWeight = 0;

        for (const [key, weight] of Object.entries(weights)) {
            const metric = metrics[key];
            if (metric === 'n/a') continue;

            totalWeight += weight;
            if (metric.passed) score += weight;
        }

        return totalWeight > 0 ? (score / totalWeight) * 100 : 100;
    }

    scoreToGrade(score) {
        if (score >= 95) return 'A+';
        if (score >= 90) return 'A';
        if (score >= 85) return 'B+';
        if (score >= 80) return 'B';
        if (score >= 70) return 'C';
        if (score >= 60) return 'D';
        return 'F';
    }

    updateSummary(analysis) {
        this.summary.total++;

        if (analysis.grade !== 'F') {
            this.summary.passed++;
        } else {
            this.summary.failed++;
        }

        const cat = analysis.category;

        // Inicializa categoria se não existir
        if (!this.summary.byCategory[cat]) {
            this.summary.byCategory[cat] = {
                total: 0,
                passed: 0,
                scoreSum: 0,
                avgScore: 0
            };
        }

        // Atualiza contadores
        this.summary.byCategory[cat].total++;

        if (analysis.grade !== 'F') {
            this.summary.byCategory[cat].passed++;
        }

        // Soma score
        this.summary.byCategory[cat].scoreSum += analysis.score;

        // Calcula média real
        this.summary.byCategory[cat].avgScore =
            this.summary.byCategory[cat].scoreSum /
            this.summary.byCategory[cat].total;
    }


    // ============ RELATÓRIOS ============

    getReport() {
        return {
            summary: this.summary,
            gradeDistribution: this.getGradeDistribution(),
            topFailures: this.getTopFailures(),
            byCategory: this.summary.byCategory,
            recommendations: this.generateRecommendations()
        };
    }

    getGradeDistribution() {
        const grades = {};
        this.interactions.forEach(i => {
            grades[i.grade] = (grades[i.grade] || 0) + 1;
        });
        return grades;
    }

    getTopFailures() {
        return this.interactions
            .filter(i => i.grade === 'F' || i.score < 70)
            .sort((a, b) => a.score - b.score)
            .slice(0, 10)
            .map(i => ({
                id: i.id,
                category: i.category,
                score: i.score,
                failedMetrics: Object.entries(i.metrics)
                    .filter(([k, v]) => v !== 'n/a' && !v.passed)
                    .map(([k, v]) => ({ metric: k, reason: v.reason }))
            }));
    }

    generateRecommendations() {
        const recs = [];
        const failures = this.getTopFailures();

        // Analisa padrões de falha
        const noCTA = failures.filter(f =>
            f.failedMetrics.some(m => m.metric === 'cta')
        ).length;
        const noContext = failures.filter(f =>
            f.failedMetrics.some(m => m.metric === 'priceContext')
        ).length;
        const safetyIssues = failures.filter(f =>
            f.failedMetrics.some(m => m.metric === 'safety')
        ).length;

        if (noCTA > 5) recs.push('CTA ausente em alta intenção — revisar modo CLOSER');
        if (noContext > 3) recs.push('Preço sem contexto — revisar regra de preço');
        if (safetyIssues > 0) recs.push('VIOLAÇÕES CRÍTICAS — revisar imediatamente');

        return recs;
    }

    exportToCSV() {
        const headers = ['id', 'category', 'score', 'grade', 'answered', 'continuity', 'cta', 'priceCtx', 'personalization', 'tone', 'safety'];

        const rows = this.interactions.map(i => [
            i.id,
            i.category,
            i.score.toFixed(1),
            i.grade,
            i.metrics.answeredQuestion.passed ? 1 : 0,
            i.metrics.continuity.passed ? 1 : 0,
            i.metrics.cta.passed ? 1 : 0,
            i.metrics.priceContext === 'n/a' ? 'n/a' : (i.metrics.priceContext.passed ? 1 : 0),
            i.metrics.personalization.passed ? 1 : 0,
            i.metrics.tone.passed ? 1 : 0,
            i.metrics.safety.passed ? 1 : 0
        ]);

        return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    }

    checkSchedulingStrategy(context, output) {
        if (!context.flags?.wantsSchedule) {
            return { passed: true, reason: 'no scheduling context' };
        }

        const isHot = context.intentScore >= 70;
        const hasConcreteSlot = /\b\d{1,2}:\d{2}\b/.test(output);
        const askedPeriod = /(manhã|tarde|período)/i.test(output);

        if (isHot) {
            return {
                passed: hasConcreteSlot,
                reason: hasConcreteSlot
                    ? 'hot lead offered concrete slot'
                    : askedPeriod
                        ? 'hot lead fell to generic period'
                        : 'hot lead without clear slot'
            };
        }

        return {
            passed: true,
            reason: 'non-hot lead'
        };
    }

    checkConversationProgress(context, output) {
        const progressPatterns = [
            /posso (agendar|marcar|reservar|garantir)/i,
            /quer que eu/i,
            /vamos (agendar|marcar)/i,
            /prefere/i,
            /qual (horário|dia)/i,
            /\b\d{1,2}:\d{2}\b/
        ];

        const progressed = progressPatterns.some(p => p.test(output));

        return {
            passed: progressed,
            reason: progressed
                ? 'conversation advanced'
                : 'no forward movement'
        };
    }

}

