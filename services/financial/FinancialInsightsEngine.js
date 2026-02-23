// services/financial/FinancialInsightsEngine.js
// Motor de insights financeiros - gera alertas estratégicos baseados em regras

class FinancialInsightsEngine {
    
    /**
     * Gera insights baseados nos dados financeiros e variações
     */
    generateInsights(metrics, variation, comparisonData) {
        const insights = [];

        // 1. Despesas cresceram mais que receita (só se ambos forem válidos)
        if (variation.despesas !== null && variation.receita !== null) {
            const varDespesas = variation.despesas;
            const varReceita = variation.receita;
            if (varDespesas > varReceita && varDespesas > 0) {
                insights.push({
                    type: 'warning',
                    severity: 'medium',
                    code: 'EXPENSE_GROWTH',
                    message: 'Despesas cresceram acima da receita este mês',
                    detail: `+${varDespesas.toFixed(1)}% despesas vs +${varReceita.toFixed(1)}% receita`
                });
            }
        }

        // 2. Margem abaixo do ideal
        const margemPercentual = metrics.margem * 100;
        if (margemPercentual < 20) {
            insights.push({
                type: 'risk',
                severity: 'high',
                code: 'LOW_MARGIN',
                message: 'Margem de lucro está abaixo do ideal',
                detail: `${margemPercentual.toFixed(1)}% (ideal: acima de 30%)`
            });
        } else if (margemPercentual < 30) {
            insights.push({
                type: 'warning',
                severity: 'medium',
                code: 'MARGIN_ATTENTION',
                message: 'Margem de lucro requer atenção',
                detail: `${margemPercentual.toFixed(1)}% (ideal: acima de 30%)`
            });
        }

        // 3. Meta em risco
        if (metrics.projecao < metrics.meta) {
            const gap = metrics.meta - metrics.projecao;
            const gapPercent = (gap / metrics.meta) * 100;
            insights.push({
                type: 'warning',
                severity: gapPercent > 20 ? 'high' : 'medium',
                code: 'GOAL_AT_RISK',
                message: 'Projeção indica risco de não atingir a meta',
                detail: `Projetado: R$ ${metrics.projecao.toLocaleString('pt-BR')} (faltam R$ ${gap.toLocaleString('pt-BR')})`
            });
        } else {
            insights.push({
                type: 'positive',
                severity: 'good',
                code: 'GOAL_ON_TRACK',
                message: 'Meta mensal está no caminho certo',
                detail: `Projetado: R$ ${metrics.projecao.toLocaleString('pt-BR')} (meta: R$ ${metrics.meta.toLocaleString('pt-BR')})`
            });
        }

        // 4. Receita caiu vs período comparado (só se houver dados válidos)
        if (variation.receita !== null) {
            if (variation.receita < 0) {
                insights.push({
                    type: 'risk',
                    severity: 'high',
                    code: 'REVENUE_DROP',
                    message: 'Receita caiu em relação ao período anterior',
                    detail: `${variation.receita.toFixed(1)}% de queda`
                });
            } else if (variation.receita > 15) {
                insights.push({
                    type: 'positive',
                    severity: 'good',
                    code: 'REVENUE_GROWTH',
                    message: 'Ótimo crescimento de receita',
                    detail: `+${variation.receita.toFixed(1)}% vs período anterior`
                });
            }
        }

        // 5. Crescimento sustentável (receita cresce mais que despesas)
        // Só mostra se ambas as variações forem válidas (não null)
        const varRec = variation.receita;
        const varDesp = variation.despesas;
        if (varRec !== null && varDesp !== null && varRec > varDesp && varRec > 5) {
            insights.push({
                type: 'positive',
                severity: 'good',
                code: 'SUSTAINABLE_GROWTH',
                message: 'Crescimento sustentável detectado',
                detail: `Receita +${varRec.toFixed(1)}% cresceu mais que despesas +${varDesp.toFixed(1)}%`
            });
        }

        // 6. Dependência de convênio (se disponível nos dados)
        if (metrics.aReceber > 0 && metrics.receita > 0) {
            const dependenciaConvenio = (metrics.aReceber / (metrics.receita + metrics.aReceber)) * 100;
            if (dependenciaConvenio > 60) {
                insights.push({
                    type: 'warning',
                    severity: 'medium',
                    code: 'HIGH_INSURANCE_DEPENDENCY',
                    message: 'Alta dependência de convênios',
                    detail: `${dependenciaConvenio.toFixed(1)}% da receita depende de convênios`
                });
            }
        }

        // 7. Lucro negativo / crescimento de lucro
        if (metrics.lucro < 0) {
            insights.push({
                type: 'risk',
                severity: 'critical',
                code: 'NEGATIVE_PROFIT',
                message: 'Prejuízo no período',
                detail: `R$ ${Math.abs(metrics.lucro).toLocaleString('pt-BR')}`
            });
        } else if (variation.lucro !== null && variation.lucro > 20) {
            insights.push({
                type: 'positive',
                severity: 'good',
                code: 'PROFIT_GROWTH',
                message: 'Lucro cresceu significativamente',
                detail: `+${variation.lucro.toFixed(1)}% vs período anterior`
            });
        }

        // Ordenar por severidade
        const severityOrder = { critical: 0, high: 1, medium: 2, good: 3 };
        return insights.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    }

    /**
     * Calcula projeção de faturamento para o final do mês
     */
    calculateProjection(receitaAtual, diaAtual, totalDiasMes) {
        if (diaAtual === 0) return receitaAtual;
        const ritmoDiario = receitaAtual / diaAtual;
        return Math.round(ritmoDiario * totalDiasMes);
    }

    /**
     * Calcula valor diário necessário para bater meta
     */
    calculateDailyRequired(meta, receitaAtual, diasRestantes) {
        if (diasRestantes <= 0) return 0;
        const faltante = meta - receitaAtual;
        if (faltante <= 0) return 0;
        return Math.round(faltante / diasRestantes);
    }

    /**
     * Calcula variação percentual entre dois valores
     * Limita a variação a um range razoável (-100% a +300%)
     * Retorna null se a variação for muito extrema (indica dados inconsistentes)
     */
    calculateVariation(atual, anterior) {
        if (!anterior || anterior === 0) return null;
        if (!atual || atual === 0) return null;
        
        const variacao = ((atual - anterior) / anterior) * 100;
        
        // Se a variação for muito extrema (>300% ou <-90%), considera inválida
        // Isso acontece quando o mês anterior teve receita muito baixa
        if (variacao > 300 || variacao < -90) {
            return null;
        }
        
        return variacao;
    }
}

export default new FinancialInsightsEngine();
