/**
 * 🎯 Serviço de Scoring Inteligente SaaS
 * Fórmula avançada considerando conversionRate, growthRate e múltiplos fatores
 */


// Pesos da fórmula (ajustáveis)
const SCORE_WEIGHTS = {
  conversionRate: 0.40,    // Taxa de conversão (leads/visitas)
  leadVelocity: 0.25,      // Velocidade de novos leads
  engagementQuality: 0.20, // Qualidade do engajamento
  growthRate: 0.15         // Crescimento vs período anterior
};

// Thresholds para alertas
const ALERT_THRESHOLDS = {
  lowConversion: 0.02,     // < 2% conversão = alerta
  highBounce: 0.70,        // > 70% bounce = alerta
  stagnantDays: 7,         // Sem leads por 7 dias = alerta
  suddenDrop: 0.50         // Queda de 50% = alerta
};

/**
 * 🎯 Calcula score completo de uma landing page
 */
export async function calculateLandingPageScore(lpData, period = 30) {
  const {
    slug,
    visits = [],
    leads = [],
    interactions = [],
    historicalData = []
  } = lpData;
  
  const now = new Date();
  const periodStart = new Date(now - period * 24 * 60 * 60 * 1000);
  
  // Filtrar dados do período
  const periodVisits = visits.filter(v => new Date(v.date) >= periodStart);
  const periodLeads = leads.filter(l => new Date(l.createdAt) >= periodStart);
  
  // Métricas base
  const metrics = {
    totalVisits: periodVisits.length,
    totalLeads: periodLeads.length,
    uniqueVisitors: countUniqueVisitors(periodVisits),
    whatsappClicks: countWhatsAppClicks(interactions, periodStart),
    formStarts: countFormEvents(interactions, 'form_start', periodStart),
    formSubmissions: countFormEvents(interactions, 'form_submit', periodStart),
    avgTimeOnPage: calculateAvgTime(periodVisits),
    bounceRate: calculateBounceRate(periodVisits)
  };
  
  // Taxa de conversão principal
  metrics.conversionRate = metrics.totalVisits > 0 
    ? metrics.totalLeads / metrics.totalVisits 
    : 0;
  
  // Taxa de conversão de cliques WhatsApp
  metrics.whatsappConversionRate = metrics.totalVisits > 0
    ? metrics.whatsappClicks / metrics.totalVisits
    : 0;
  
  // Calcular componentes do score
  const scores = {
    conversionScore: calculateConversionScore(metrics.conversionRate),
    velocityScore: calculateVelocityScore(periodLeads, period),
    engagementScore: calculateEngagementScore(metrics),
    growthScore: calculateGrowthScore(historicalData, periodLeads.length, period)
  };
  
  // Score final ponderado (0-100)
  const finalScore = Math.round(
    scores.conversionScore * SCORE_WEIGHTS.conversionRate +
    scores.velocityScore * SCORE_WEIGHTS.leadVelocity +
    scores.engagementScore * SCORE_WEIGHTS.engagementQuality +
    scores.growthScore * SCORE_WEIGHTS.growthRate
  );
  
  // Gerar insights e alertas
  const analysis = analyzePerformance(metrics, scores, period);
  
  return {
    slug,
    period,
    calculatedAt: new Date(),
    score: finalScore,
    grade: getScoreGrade(finalScore),
    metrics,
    scores,
    analysis,
    recommendations: generateRecommendations(analysis, metrics),
    ranking: {
      percentile: null, // Preenchido posteriormente comparando com outras LPs
      category: categorizePerformance(finalScore)
    }
  };
}

/**
 * 📊 Calcula score para múltiplas landing pages (ranking)
 */
export async function calculateMultipleScores(landingPages, period = 30) {
  const results = [];
  
  for (const lp of landingPages) {
    const score = await calculateLandingPageScore(lp, period);
    results.push(score);
  }
  
  // Calcular percentis
  const sortedByScore = [...results].sort((a, b) => b.score - a.score);
  const total = sortedByScore.length;
  
  results.forEach(result => {
    const rank = sortedByScore.findIndex(r => r.slug === result.slug);
    result.ranking.percentile = Math.round(((total - rank) / total) * 100);
    result.ranking.position = rank + 1;
  });
  
  return {
    period,
    calculatedAt: new Date(),
    totalLandingPages: total,
    averageScore: Math.round(results.reduce((sum, r) => sum + r.score, 0) / total),
    topPerformer: sortedByScore[0],
    needsAttention: sortedByScore.filter(r => r.score < 40),
    results: results.sort((a, b) => b.score - a.score)
  };
}

/**
 * 📈 Calcula tendência de crescimento
 */
export function calculateGrowthTrend(historicalData, periods = 4) {
  if (!historicalData || historicalData.length < 2) {
    return { trend: 'stable', growthRate: 0, prediction: null };
  }
  
  // Ordenar por data
  const sorted = [...historicalData].sort((a, b) => 
    new Date(a.date) - new Date(b.date)
  );
  
  // Pegar últimos N períodos
  const recent = sorted.slice(-periods);
  
  // Calcular taxa de crescimento período a período
  const growthRates = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].leads || 0;
    const curr = recent[i].leads || 0;
    if (prev > 0) {
      growthRates.push((curr - prev) / prev);
    }
  }
  
  // Média de crescimento
  const avgGrowth = growthRates.length > 0
    ? growthRates.reduce((a, b) => a + b, 0) / growthRates.length
    : 0;
  
  // Tendência
  let trend = 'stable';
  if (avgGrowth > 0.1) trend = 'growing';
  if (avgGrowth > 0.3) trend = 'strong_growth';
  if (avgGrowth < -0.1) trend = 'declining';
  if (avgGrowth < -0.3) trend = 'strong_decline';
  
  // Previsão simples para próximo período
  const lastPeriod = recent[recent.length - 1];
  const prediction = lastPeriod.leads 
    ? Math.round(lastPeriod.leads * (1 + avgGrowth))
    : null;
  
  return {
    trend,
    growthRate: avgGrowth,
    periodsAnalyzed: growthRates.length,
    prediction,
    confidence: growthRates.length >= 3 ? 'medium' : 'low'
  };
}

/**
 * 🎯 Benchmarking contra outras landing pages
 */
export function calculateBenchmark(target, allLandingPages) {
  const metrics = ['conversionRate', 'avgTimeOnPage', 'totalLeads'];
  const benchmarks = {};
  
  metrics.forEach(metric => {
    const values = allLandingPages
      .map(lp => lp.metrics?.[metric])
      .filter(v => v !== undefined && v !== null)
      .sort((a, b) => a - b);
    
    const targetValue = target.metrics?.[metric];
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    const median = values[Math.floor(values.length / 2)];
    const p90 = values[Math.floor(values.length * 0.9)];
    
    benchmarks[metric] = {
      value: targetValue,
      average: avg,
      median,
      percentile90: p90,
      vsAverage: avg > 0 ? (targetValue - avg) / avg : 0,
      vsMedian: median > 0 ? (targetValue - median) / median : 0,
      vsTop10: p90 > 0 ? (targetValue - p90) / p90 : 0
    };
  });
  
  return benchmarks;
}

// ============ SCORING HELPERS ============

function calculateConversionScore(rate) {
  // Score baseado na taxa de conversão
  // Excelente: > 5% = 100 pontos
  // Bom: 3-5% = 80-100 pontos
  // Médio: 1-3% = 40-80 pontos
  // Baixo: < 1% = 0-40 pontos
  
  if (rate >= 0.05) return 100;
  if (rate >= 0.03) return 80 + (rate - 0.03) / 0.02 * 20;
  if (rate >= 0.01) return 40 + (rate - 0.01) / 0.02 * 40;
  return rate / 0.01 * 40;
}

function calculateVelocityScore(leads, periodDays) {
  // Velocidade: leads por dia
  const leadsPerDay = leads.length / periodDays;
  
  // Benchmarks (ajustar conforme base real)
  if (leadsPerDay >= 2) return 100;
  if (leadsPerDay >= 1) return 80 + (leadsPerDay - 1) * 20;
  if (leadsPerDay >= 0.5) return 60 + (leadsPerDay - 0.5) * 40;
  if (leadsPerDay >= 0.1) return 30 + (leadsPerDay - 0.1) / 0.4 * 30;
  return leadsPerDay / 0.1 * 30;
}

function calculateEngagementScore(metrics) {
  // Score baseado em qualidade do engajamento
  let score = 50; // Base
  
  // Bounce rate (menor é melhor)
  if (metrics.bounceRate < 0.3) score += 20;
  else if (metrics.bounceRate < 0.5) score += 10;
  else if (metrics.bounceRate > 0.7) score -= 15;
  
  // Tempo na página
  if (metrics.avgTimeOnPage > 120) score += 15;
  else if (metrics.avgTimeOnPage > 60) score += 10;
  else if (metrics.avgTimeOnPage < 10) score -= 10;
  
  // Taxa de cliques no WhatsApp
  if (metrics.whatsappConversionRate > 0.1) score += 15;
  else if (metrics.whatsappConversionRate > 0.05) score += 10;
  
  return Math.max(0, Math.min(100, score));
}

function calculateGrowthScore(historicalData, currentLeads, period) {
  if (!historicalData || historicalData.length < 2) return 50;
  
  const trend = calculateGrowthTrend(historicalData);
  
  // Converter taxa de crescimento em score
  const growthRate = trend.growthRate;
  
  if (growthRate >= 0.5) return 100;
  if (growthRate >= 0.2) return 80 + (growthRate - 0.2) / 0.3 * 20;
  if (growthRate >= 0) return 50 + growthRate / 0.2 * 30;
  if (growthRate >= -0.2) return 50 + growthRate / 0.2 * 20;
  if (growthRate >= -0.5) return 30 + (growthRate + 0.2) / 0.3 * 20;
  return Math.max(0, 30 + (growthRate + 0.5) / 0.5 * 30);
}

function analyzePerformance(metrics, scores, period) {
  const alerts = [];
  const positives = [];
  
  // Verificar problemas
  if (metrics.conversionRate < ALERT_THRESHOLDS.lowConversion) {
    alerts.push({
      type: 'low_conversion',
      severity: 'high',
      message: `Taxa de conversão baixa (${(metrics.conversionRate * 100).toFixed(1)}%)`,
      threshold: `${(ALERT_THRESHOLDS.lowConversion * 100).toFixed(0)}%`
    });
  }
  
  if (metrics.bounceRate > ALERT_THRESHOLDS.highBounce) {
    alerts.push({
      type: 'high_bounce',
      severity: 'medium',
      message: `Taxa de rejeição alta (${(metrics.bounceRate * 100).toFixed(0)}%)`,
      threshold: `${(ALERT_THRESHOLDS.highBounce * 100).toFixed(0)}%`
    });
  }
  
  if (metrics.totalLeads === 0) {
    alerts.push({
      type: 'no_leads',
      severity: 'high',
      message: `Sem leads nos últimos ${period} dias`
    });
  }
  
  // Verificar pontos positivos
  if (metrics.conversionRate >= 0.05) {
    positives.push({
      type: 'excellent_conversion',
      message: `Excelente taxa de conversão (${(metrics.conversionRate * 100).toFixed(1)}%)`
    });
  }
  
  if (scores.growthScore >= 80) {
    positives.push({
      type: 'growing',
      message: 'Crescimento acelerado no período'
    });
  }
  
  return { alerts, positives };
}

function generateRecommendations(analysis, metrics) {
  const recommendations = [];
  
  // Baseado nos alertas
  analysis.alerts.forEach(alert => {
    switch (alert.type) {
      case 'low_conversion':
        recommendations.push({
          priority: 'high',
          category: 'conversion',
          action: 'Revisar CTA e posicionamento do botão WhatsApp',
          expectedImpact: '+2-5% conversão'
        });
        recommendations.push({
          priority: 'high',
          category: 'content',
          action: 'Adicionar prova social (depoimentos, cases)',
          expectedImpact: '+1-3% conversão'
        });
        break;
        
      case 'high_bounce':
        recommendations.push({
          priority: 'medium',
          category: 'ux',
          action: 'Melhorar velocidade de carregamento da página',
          expectedImpact: '-20% bounce rate'
        });
        recommendations.push({
          priority: 'medium',
          category: 'content',
          action: 'Revisar headline - garantir alinhamento com anúncio',
          expectedImpact: '-15% bounce rate'
        });
        break;
        
      case 'no_leads':
        recommendations.push({
          priority: 'high',
          category: 'traffic',
          action: 'Verificar se há tráfego sendo direcionado',
          expectedImpact: 'Leads imediatos'
        });
        break;
    }
  });
  
  // Recomendações genéricas baseadas em métricas
  if (metrics.whatsappConversionRate < 0.05) {
    recommendations.push({
      priority: 'medium',
      category: 'conversion',
      action: 'Tornar botão WhatsApp flutuante/sticky',
      expectedImpact: '+50% cliques'
    });
  }
  
  return recommendations;
}

// ============ METRIC HELPERS ============

function countUniqueVisitors(visits) {
  const uniqueIps = new Set(visits.map(v => v.ip || v.visitorId));
  return uniqueIps.size;
}

function countWhatsAppClicks(interactions, since) {
  return interactions.filter(i => 
    i.type === 'whatsapp_click' &&
    new Date(i.timestamp) >= since
  ).length;
}

function countFormEvents(interactions, eventType, since) {
  return interactions.filter(i =>
    i.type === eventType &&
    new Date(i.timestamp) >= since
  ).length;
}

function calculateAvgTime(visits) {
  if (!visits.length) return 0;
  const times = visits
    .filter(v => v.timeOnPage)
    .map(v => v.timeOnPage);
  return times.length 
    ? times.reduce((a, b) => a + b, 0) / times.length 
    : 0;
}

function calculateBounceRate(visits) {
  if (!visits.length) return 0;
  const bounces = visits.filter(v => !v.interacted).length;
  return bounces / visits.length;
}

function getScoreGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  if (score >= 40) return 'E';
  return 'F';
}

function categorizePerformance(score) {
  if (score >= 80) return 'excelente';
  if (score >= 60) return 'bom';
  if (score >= 40) return 'regular';
  return 'precisa_atencao';
}

export default {
  calculateLandingPageScore,
  calculateMultipleScores,
  calculateGrowthTrend,
  calculateBenchmark,
  SCORE_WEIGHTS,
  ALERT_THRESHOLDS
};
