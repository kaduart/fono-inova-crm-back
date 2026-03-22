/**
 * 💡 Serviço de Recomendações Automáticas
 * Gera insights acionáveis baseados em dados reais
 */

import { calculateGrowthTrend } from './intelligentScoringService.js';

// Base de conhecimento de recomendações
const RECOMMENDATION_DB = {
  // Problemas de conversão
  low_conversion: {
    symptoms: ['conversionRate < 0.02', 'leads == 0', 'visits > 100'],
    recommendations: [
      {
        id: 'cta_visibility',
        title: 'Melhorar visibilidade do CTA',
        description: 'O botão de WhatsApp deve estar visível sem scroll (acima da dobra). Teste versões flutuantes.',
        effort: 'low',
        impact: 'high',
        expectedResult: '+2-5% na taxa de conversão',
        implementation: 'Adicionar classe sticky ao botão de WhatsApp'
      },
      {
        id: 'social_proof',
        title: 'Adicionar prova social',
        description: 'Incluir depoimentos de pais, badges de confiança, números de pacientes atendidos.',
        effort: 'medium',
        impact: 'medium',
        expectedResult: '+1-3% na conversão',
        implementation: 'Seção de depoimentos com fotos e nomes reais'
      },
      {
        id: 'urgency_scarcity',
        title: 'Criar senso de urgência',
        description: 'Adicionar contadores de vagas disponíveis ou tempo limitado para agendamento.',
        effort: 'low',
        impact: 'medium',
        expectedResult: '+1-2% na conversão',
        implementation: 'Badge "Apenas X vagas este mês"'
      }
    ]
  },
  
  // Problemas de bounce
  high_bounce: {
    symptoms: ['bounceRate > 0.70', 'avgTimeOnPage < 10'],
    recommendations: [
      {
        id: 'page_speed',
        title: 'Otimizar velocidade de carregamento',
        description: 'Páginas lentas causam abandonos imediatos. Comprimir imagens, lazy loading.',
        effort: 'medium',
        impact: 'high',
        expectedResult: '-20% bounce rate',
        implementation: 'Usar formato WebP, lazy loading em imagens abaixo da dobra'
      },
      {
        id: 'headline_alignment',
        title: 'Alinhar headline com origem do tráfego',
        description: 'Se o usuário veio de um anúncio sobre "fala tardia", a página deve falar disso imediatamente.',
        effort: 'low',
        impact: 'high',
        expectedResult: '-15% bounce rate',
        implementation: 'Personalizar headline baseada em UTM parameters'
      },
      {
        id: 'mobile_optimization',
        title: 'Verificar experiência mobile',
        description: '70%+ do tráfego é mobile. Testar botões grandes, texto legível, sem popups invasivos.',
        effort: 'medium',
        impact: 'high',
        expectedResult: '-25% bounce rate mobile',
        implementation: 'Teste em múltiplos dispositivos, fonte mínimo 16px'
      }
    ]
  },
  
  // Problemas de tráfego
  low_traffic: {
    symptoms: ['visits < 50', 'noOrganicTraffic'],
    recommendations: [
      {
        id: 'seo_optimization',
        title: 'Otimizar SEO on-page',
        description: 'Melhorar títulos, meta descriptions, headings H1-H2, alt text de imagens.',
        effort: 'medium',
        impact: 'medium',
        expectedResult: '+50% tráfego orgânico em 3 meses',
        implementation: 'Keyword research, otimizar título para "Avaliação Autismo Anápolis"'
      },
      {
        id: 'gmb_posts',
        title: 'Aumentar frequência de posts no GMB',
        description: 'Google My Business gera tráfego local qualificado. Postar 3x por semana.',
        effort: 'low',
        impact: 'medium',
        expectedResult: '+30% tráfego local',
        implementation: 'Agendar posts com ofertas, dicas, depoimentos'
      },
      {
        id: 'paid_ads',
        title: 'Investir em anúncios pagos',
        description: 'Tráfego imediato e mensurável via Google Ads e Meta Ads.',
        effort: 'high',
        impact: 'high',
        expectedResult: 'Tráfego imediato',
        implementation: 'Campanha Google Ads "fono anapolis", Remarketing Meta'
      }
    ]
  },
  
  // Problemas de qualidade de lead
  low_quality_leads: {
    symptoms: ['conversionRate > 0.05', 'noShows > 0.5'],
    recommendations: [
      {
        id: 'qualify_form',
        title: 'Adicionar perguntas qualificadoras',
        description: 'Formulário com idade da criança, principal queixa, urgência. Filtra curiosos.',
        effort: 'medium',
        impact: 'medium',
        expectedResult: '-40% no-shows',
        implementation: 'Form com 3-4 perguntas antes do WhatsApp'
      },
      {
        id: 'confirmation_flow',
        title: 'Implementar confirmação automática',
        description: 'WhatsApp automático confirmando agendamento 24h antes.',
        effort: 'low',
        impact: 'high',
        expectedResult: '-30% faltas',
        implementation: 'Bot Amanda envia lembrete automático'
      }
    ]
  },
  
  // Oportunidades de crescimento
  growth_opportunity: {
    symptoms: ['growthRate > 0.3', 'score > 70'],
    recommendations: [
      {
        id: 'scale_ads',
        title: 'Aumentar investimento em ads',
        description: 'Landing page performando bem é sinal para escalar orçamento.',
        effort: 'low',
        impact: 'high',
        expectedResult: '2-3x leads mantendo CPA',
        implementation: 'Aumentar budget em 50%, monitorar CPA'
      },
      {
        id: 'ab_test',
        title: 'Iniciar testes A/B',
        description: 'Testar variações de headline, CTA, imagens para otimizar ainda mais.',
        effort: 'medium',
        impact: 'medium',
        expectedResult: '+10-20% conversão',
        implementation: 'Google Optimize ou teste manual 50/50'
      }
    ]
  }
};

// Templates de relatório
const REPORT_TEMPLATES = {
  executive: {
    name: 'Resumo Executivo',
    sections: ['overview', 'top_performers', 'alerts', 'priorities'],
    maxRecommendations: 3
  },
  detailed: {
    name: 'Relatório Detalhado',
    sections: ['overview', 'all_pages', 'trends', 'alerts', 'all_recommendations', 'action_plan'],
    maxRecommendations: 10
  },
  tactical: {
    name: 'Plano de Ação',
    sections: ['urgent_actions', 'quick_wins', 'medium_term', 'monitoring'],
    maxRecommendations: 5
  }
};

/**
 * 🔍 Detecta problemas e oportunidades
 */
export function detectIssuesAndOpportunities(landingPageData) {
  const issues = [];
  const opportunities = [];
  
  // Verificar cada diagnóstico na base
  for (const [category, data] of Object.entries(RECOMMENDATION_DB)) {
    const matches = checkSymptoms(data.symptoms, landingPageData);
    
    if (matches) {
      const item = {
        category,
        severity: calculateSeverity(category, landingPageData),
        matchedSymptoms: matches,
        recommendations: data.recommendations
      };
      
      if (category.includes('opportunity')) {
        opportunities.push(item);
      } else {
        issues.push(item);
      }
    }
  }
  
  return { issues, opportunities };
}

/**
 * 📊 Gera relatório completo
 */
export async function generateReport(allLandingPages, options = {}) {
  const {
    template = 'detailed',
    period = 30,
    focusAreas = []
  } = options;
  
  const templateConfig = REPORT_TEMPLATES[template];
  const report = {
    generatedAt: new Date(),
    period,
    template: templateConfig.name,
    summary: {},
    sections: []
  };
  
  // 1. Visão geral
  report.summary = generateOverview(allLandingPages);
  
  // 2. Analisar cada landing page
  const pageAnalyses = allLandingPages.map(lp => ({
    slug: lp.slug,
    ...detectIssuesAndOpportunities(lp),
    metrics: lp.metrics,
    score: lp.score
  }));
  
  // 3. Priorizar recomendações
  const allRecommendations = prioritizeRecommendations(pageAnalyses);
  
  // 4. Gerar seções conforme template
  for (const sectionName of templateConfig.sections) {
    report.sections.push(
      generateSection(sectionName, pageAnalyses, allRecommendations, report.summary)
    );
  }
  
  // 5. Plano de ação
  report.actionPlan = generateActionPlan(allRecommendations, templateConfig.maxRecommendations);
  
  return report;
}

/**
 * 🎯 Gera prioridades do dia/semana
 */
export function generateDailyPriorities(landingPages, pendingActions = []) {
  const allIssues = [];
  
  landingPages.forEach(lp => {
    const { issues } = detectIssuesAndOpportunities(lp);
    issues.forEach(issue => {
      allIssues.push({
        ...issue,
        landingPage: lp.slug,
        impact: calculateBusinessImpact(issue, lp)
      });
    });
  });
  
  // Priorizar por impacto/urgência
  const sorted = allIssues.sort((a, b) => b.impact - a.impact);
  
  // Agrupar por tipo
  const grouped = {
    urgent: sorted.filter(i => i.severity === 'critical'),
    high: sorted.filter(i => i.severity === 'high'),
    medium: sorted.filter(i => i.severity === 'medium'),
    quickWins: sorted.filter(i => 
      i.recommendations.some(r => r.effort === 'low' && r.impact === 'high')
    )
  };
  
  return {
    generatedAt: new Date(),
    summary: {
      totalIssues: allIssues.length,
      critical: grouped.urgent.length,
      high: grouped.high.length,
      quickWins: grouped.quickWins.length
    },
    priorities: [
      {
        title: 'Ações Críticas (Resolver Hoje)',
        items: grouped.urgent.slice(0, 3).map(formatPriorityItem)
      },
      {
        title: 'Quick Wins (Baixo Esforço, Alto Impacto)',
        items: grouped.quickWins.slice(0, 3).map(formatPriorityItem)
      },
      {
        title: 'Melhorias de Alta Prioridade',
        items: grouped.high.slice(0, 5).map(formatPriorityItem)
      }
    ],
    pendingActions: pendingActions.filter(a => !a.completed).slice(0, 5)
  };
}

/**
 * 📈 Gera previsões e cenários
 */
export function generateForecasts(historicalData, scenarios = ['conservative', 'realistic', 'optimistic']) {
  const trend = calculateGrowthTrend(historicalData);
  const forecasts = {};
  
  const multipliers = {
    conservative: 0.7,
    realistic: 1.0,
    optimistic: 1.5
  };
  
  scenarios.forEach(scenario => {
    const baseGrowth = trend.growthRate * multipliers[scenario];
    const lastValue = historicalData[historicalData.length - 1]?.leads || 0;
    
    forecasts[scenario] = {
      growthRate: baseGrowth,
      next30Days: Math.round(lastValue * (1 + baseGrowth)),
      next90Days: Math.round(lastValue * Math.pow(1 + baseGrowth, 3)),
      confidence: scenario === 'realistic' ? 'medium' : 'low'
    };
  });
  
  return {
    basedOn: historicalData.length,
    trend,
    forecasts,
    recommendations: generateForecastRecommendations(trend, forecasts)
  };
}

// ============ HELPERS ============

function checkSymptoms(symptoms, data) {
  const matches = [];
  
  for (const symptom of symptoms) {
    const [metric, operator, threshold] = parseSymptom(symptom);
    const value = getMetricValue(metric, data);
    
    if (evaluateCondition(value, operator, threshold)) {
      matches.push({ metric, value, threshold, operator });
    }
  }
  
  // Considera match se pelo menos metade dos sintomas bater
  return matches.length >= symptoms.length / 2 ? matches : null;
}

function parseSymptom(symptom) {
  // Parse sintomas como: "conversionRate < 0.02", "leads == 0"
  const operators = ['<=', '>=', '==', '<', '>'];
  
  for (const op of operators) {
    if (symptom.includes(op)) {
      const [metric, threshold] = symptom.split(op).map(s => s.trim());
      return [metric, op, parseFloat(threshold)];
    }
  }
  
  return [symptom, 'exists', null];
}

function getMetricValue(metric, data) {
  const mapping = {
    conversionRate: data.metrics?.conversionRate,
    bounceRate: data.metrics?.bounceRate,
    visits: data.metrics?.totalVisits,
    leads: data.metrics?.totalLeads,
    avgTimeOnPage: data.metrics?.avgTimeOnPage,
    growthRate: data.growthRate,
    score: data.score
  };
  
  return mapping[metric] ?? data[metric];
}

function evaluateCondition(value, operator, threshold) {
  switch (operator) {
    case '<': return value < threshold;
    case '>': return value > threshold;
    case '<=': return value <= threshold;
    case '>=': return value >= threshold;
    case '==': return value == threshold;
    case 'exists': return value !== undefined && value !== null;
    default: return false;
  }
}

function calculateSeverity(category, data) {
  const severities = {
    low_conversion: data.metrics?.conversionRate < 0.01 ? 'critical' : 'high',
    high_bounce: data.metrics?.bounceRate > 0.80 ? 'critical' : 'high',
    low_traffic: 'medium',
    low_quality_leads: 'medium',
    growth_opportunity: 'low'
  };
  
  return severities[category] || 'medium';
}

function calculateBusinessImpact(issue, lpData) {
  // Calcular impacto estimado em leads/mês
  const baseLeads = lpData.metrics?.totalLeads || 0;
  const improvement = issue.recommendations.reduce((sum, r) => {
    const match = r.expectedResult.match(/([\d.]+)%/);
    return sum + (match ? parseFloat(match[1]) : 10);
  }, 0) / issue.recommendations.length;
  
  return Math.round(baseLeads * (improvement / 100));
}

function prioritizeRecommendations(pageAnalyses) {
  const allRecs = [];
  
  pageAnalyses.forEach(analysis => {
    [...analysis.issues, ...analysis.opportunities].forEach(item => {
      item.recommendations.forEach(rec => {
        allRecs.push({
          ...rec,
          category: item.category,
          severity: item.severity,
          landingPage: analysis.slug,
          priorityScore: calculatePriorityScore(rec, item.severity)
        });
      });
    });
  });
  
  return allRecs.sort((a, b) => b.priorityScore - a.priorityScore);
}

function calculatePriorityScore(rec, severity) {
  const effortWeight = { low: 1, medium: 0.7, high: 0.4 };
  const impactWeight = { high: 1, medium: 0.6, low: 0.3 };
  const severityWeight = { critical: 1.5, high: 1.2, medium: 1, low: 0.8 };
  
  return (
    effortWeight[rec.effort] * 
    impactWeight[rec.impact] * 
    severityWeight[severity] * 
    100
  );
}

function generateOverview(allPages) {
  const scores = allPages.map(p => p.score || 0);
  
  return {
    totalLandingPages: allPages.length,
    averageScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    topPerformer: allPages.reduce((best, current) => 
      (current.score || 0) > (best.score || 0) ? current : best
    , allPages[0]),
    needsAttention: allPages.filter(p => (p.score || 0) < 40).length,
    totalLeads: allPages.reduce((sum, p) => sum + (p.metrics?.totalLeads || 0), 0),
    totalVisits: allPages.reduce((sum, p) => sum + (p.metrics?.totalVisits || 0), 0)
  };
}

function generateSection(name, analyses, recommendations, summary) {
  const generators = {
    overview: () => ({
      title: 'Visão Geral',
      content: summary
    }),
    
    top_performers: () => ({
      title: 'Top Performers',
      content: analyses
        .filter(a => a.score >= 70)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
    }),
    
    alerts: () => ({
      title: 'Alertas',
      content: analyses
        .flatMap(a => a.issues.filter(i => i.severity === 'critical' || i.severity === 'high'))
        .slice(0, 5)
    }),
    
    priorities: () => ({
      title: 'Prioridades',
      content: recommendations.slice(0, 5)
    }),
    
    all_pages: () => ({
      title: 'Todas as Landing Pages',
      content: analyses.sort((a, b) => b.score - a.score)
    }),
    
    all_recommendations: () => ({
      title: 'Todas as Recomendações',
      content: recommendations
    }),
    
    action_plan: () => ({
      title: 'Plano de Ação',
      content: generateActionPlan(recommendations, 10)
    })
  };
  
  return generators[name] ? generators[name]() : { title: name, content: [] };
}

function generateActionPlan(recommendations, maxItems) {
  const topRecs = recommendations.slice(0, maxItems);
  
  return {
    immediate: topRecs.filter(r => r.effort === 'low' && r.severity === 'critical'),
    thisWeek: topRecs.filter(r => 
      (r.effort === 'low' && r.severity === 'high') || 
      (r.effort === 'medium' && r.severity === 'critical')
    ),
    thisMonth: topRecs.filter(r => 
      r.effort === 'medium' || r.effort === 'high'
    ),
    monitoring: topRecs.filter(r => r.impact === 'low')
  };
}

function formatPriorityItem(issue) {
  const topRec = issue.recommendations[0];
  
  return {
    landingPage: issue.landingPage,
    issue: issue.category,
    severity: issue.severity,
    action: topRec.title,
    description: topRec.description,
    expectedResult: topRec.expectedResult,
    effort: topRec.effort,
    impact: topRec.impact
  };
}

function generateForecastRecommendations(trend, forecasts) {
  const recs = [];
  
  if (trend.trend === 'declining' || trend.trend === 'strong_decline') {
    recs.push({
      priority: 'critical',
      action: 'Revisar estratégia de aquisição',
      reason: 'Tendência de queda detectada'
    });
  }
  
  if (forecasts.optimistic.next30Days > forecasts.realistic.next30Days * 1.5) {
    recs.push({
      priority: 'medium',
      action: 'Preparar infraestrutura para crescimento',
      reason: 'Potencial de alta demanda no cenário otimista'
    });
  }
  
  return recs;
}

export default {
  detectIssuesAndOpportunities,
  generateReport,
  generateDailyPriorities,
  generateForecasts,
  RECOMMENDATION_DB
};
