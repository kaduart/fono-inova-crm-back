/**
 * 🚨 Serviço de Alertas Inteligentes
 * Gera alertas automáticos baseados em métricas das LPs
 */

import Alert from '../models/Alert.js';
import LandingPage from '../models/LandingPage.js';

// Thresholds para alertas
const THRESHOLDS = {
  conversion: {
    critical: { rate: 0.02, minViews: 100 },  // < 2% com 100+ views
    high: { rate: 0.05, minViews: 100 },      // < 5% com 100+ views
    medium: { rate: 0.08, minViews: 50 }      // < 8% com 50+ views
  },
  traffic: {
    critical: { views: 10, days: 7 },         // < 10 views em 7 dias
    high: { views: 30, days: 7 },             // < 30 views em 7 dias
    medium: { dropPercent: 50, days: 7 }      // Queda de 50% em 7 dias
  },
  engagement: {
    high: { bounceRate: 0.8, minViews: 50 },  // > 80% bounce rate
    medium: { avgTime: 30, minViews: 50 }     // < 30s tempo médio
  }
};

/**
 * 🎯 Analisa todas as LPs e gera alertas quando necessário
 */
export async function analyzeAndGenerateAlerts() {
  console.log('🔍 Analisando métricas para geração de alertas...');
  
  const lps = await LandingPage.find({ status: 'active' });
  const newAlerts = [];
  
  for (const lp of lps) {
    const alerts = await analyzeLandingPage(lp);
    newAlerts.push(...alerts);
  }
  
  console.log(`✅ ${newAlerts.length} alertas gerados`);
  return newAlerts;
}

/**
 * 📊 Analisa uma LP específica e retorna alertas
 */
async function analyzeLandingPage(lp) {
  const alerts = [];
  const metrics = lp.metrics || {};
  const views = metrics.views || 0;
  const leads = metrics.leads || 0;
  const conversionRate = views > 0 ? (leads / views) : 0;
  
  // 1️⃣ ALERTA: Baixa conversão
  const conversionAlert = checkConversionAlert(lp, views, leads, conversionRate);
  if (conversionAlert) alerts.push(conversionAlert);
  
  // 2️⃣ ALERTA: Baixo tráfego
  const trafficAlert = checkTrafficAlert(lp, views);
  if (trafficAlert) alerts.push(trafficAlert);
  
  // 3️⃣ ALERTA: Queda de tráfego (comparar com média histórica)
  const dropAlert = await checkTrafficDropAlert(lp);
  if (dropAlert) alerts.push(dropAlert);
  
  // 4️⃣ ALERTA: Alto CTR mas baixa conversão (problema na LP)
  const ctrAlert = checkCtrMismatchAlert(lp, views, leads);
  if (ctrAlert) alerts.push(ctrAlert);
  
  // Salvar alertas no banco
  for (const alertData of alerts) {
    await createOrUpdateAlert(alertData);
  }
  
  return alerts;
}

/**
 * 🔴 Verifica alerta de conversão
 */
function checkConversionAlert(lp, views, leads, conversionRate) {
  // Só alerta se tiver views suficientes
  if (views < THRESHOLDS.conversion.medium.minViews) return null;
  
  let level = null;
  let recommendation = '';
  
  if (conversionRate < THRESHOLDS.conversion.critical.rate && views >= THRESHOLDS.conversion.critical.minViews) {
    level = 'critical';
    recommendation = `Taxa de conversão crítica (${(conversionRate * 100).toFixed(1)}%). Sugestões: 1) Revisar CTA do WhatsApp, 2) Testar novo headline, 3) Adicionar depoimentos acima da dobra.`;
  } else if (conversionRate < THRESHOLDS.conversion.high.rate && views >= THRESHOLDS.conversion.high.minViews) {
    level = 'high';
    recommendation = `Conversão abaixo do esperado (${(conversionRate * 100).toFixed(1)}%). Ações: 1) Simplificar formulário/CTA, 2) Adicionar urgência ("vagas limitadas"), 3) Testar cor do botão WhatsApp.`;
  } else if (conversionRate < THRESHOLDS.conversion.medium.rate && views >= THRESHOLDS.conversion.medium.minViews) {
    level = 'medium';
    recommendation = `Conversão pode melhorar (${(conversionRate * 100).toFixed(1)}%). Dica: Adicionar prova social (número de famílias atendidas) e garantia.`;
  }
  
  if (!level) return null;
  
  return {
    title: `Conversão ${level === 'critical' ? 'crítica' : 'baixa'} em "${lp.title}"`,
    message: `A LP "${lp.slug}" teve ${views} visualizações e ${leads} leads (${(conversionRate * 100).toFixed(1)}% de conversão).`,
    level,
    category: 'conversion',
    landingPage: lp.slug,
    landingPageTitle: lp.title,
    metrics: { views, leads, conversionRate },
    recommendation
  };
}

/**
 * 🟡 Verifica alerta de tráfego
 */
function checkTrafficAlert(lp, views) {
  // Verificar views nos últimos 7 dias (simulado - idealmente teria histórico)
  const viewsLast7Days = lp.viewsLast7Days || views; // fallback
  
  let level = null;
  let recommendation = '';
  
  if (viewsLast7Days < THRESHOLDS.traffic.critical.views) {
    level = 'critical';
    recommendation = `Tráfego extremamente baixo (${viewsLast7Days} views/7 dias). Ações urgentes: 1) Post GMB sobre ${lp.category}, 2) Criar post no blog linkando para esta página, 3) Investir R$20 em anúncio local.`;
  } else if (viewsLast7Days < THRESHOLDS.traffic.high.views) {
    level = 'high';
    recommendation = `Tráfego baixo (${viewsLast7Days} views/7 dias). Sugestões: 1) Otimizar SEO on-page (title/meta), 2) Criar 2 posts no Instagram linkando, 3) Solicitar backlink de parceiros.`;
  }
  
  if (!level) return null;
  
  return {
    title: `Tráfego ${level === 'critical' ? 'crítico' : 'baixo'} em "${lp.title}"`,
    message: `"${lp.slug}" recebeu apenas ${viewsLast7Days} visualizações nos últimos 7 dias.`,
    level,
    category: 'traffic',
    landingPage: lp.slug,
    landingPageTitle: lp.title,
    metrics: { views: viewsLast7Days },
    recommendation
  };
}

/**
 * 📉 Verifica queda de tráfego
 */
async function checkTrafficDropAlert(lp) {
  // Simulação - em produção compararia com período anterior
  const previousViews = lp.previousPeriodViews || lp.metrics?.views * 0.5;
  const currentViews = lp.metrics?.views || 0;
  
  if (previousViews === 0) return null;
  
  const dropPercent = ((previousViews - currentViews) / previousViews) * 100;
  
  if (dropPercent >= 50) {
    return {
      title: `Queda significativa de tráfego em "${lp.title}"`,
      message: `"${lp.slug}" teve queda de ${dropPercent.toFixed(0)}% nas visualizações comparado ao período anterior.`,
      level: 'medium',
      category: 'traffic',
      landingPage: lp.slug,
      landingPageTitle: lp.title,
      metrics: { 
        previousViews, 
        currentViews, 
        dropPercent,
        currentValue: dropPercent,
        threshold: 50
      },
      recommendation: `Queda de ${dropPercent.toFixed(0)}% no tráfego. Verificar: 1) Se a página está indexada no Google, 2) Se houve mudança na URL, 3) Se GMB posts estão sendo publicados.`
    };
  }
  
  return null;
}

/**
 * 🎯 Verifica discrepância CTR vs Conversão
 */
function checkCtrMismatchAlert(lp, views, leads) {
  // Se tem muitas views mas poucos leads = problema na LP
  if (views > 100 && leads === 0) {
    return {
      title: `Alto tráfego, zero conversões em "${lp.title}"`,
      message: `"${lp.slug}" teve ${views} views mas nenhum lead gerado. Possível problema técnico ou de experiência.`,
      level: 'high',
      category: 'engagement',
      landingPage: lp.slug,
      landingPageTitle: lp.title,
      metrics: { views, leads, conversionRate: 0 },
      recommendation: `Urgente: ${views} pessoas viram a página mas ninguém clicou no WhatsApp. Verificar: 1) Botão está funcionando?, 2) Número está correto?, 3) Página carrega no mobile?`
    };
  }
  
  return null;
}

/**
 * 💾 Cria ou atualiza alerta no banco
 */
async function createOrUpdateAlert(alertData) {
  // Evitar duplicados - verificar se já existe alerta similar ativo
  const existing = await Alert.findOne({
    landingPage: alertData.landingPage,
    category: alertData.category,
    level: alertData.level,
    status: { $in: ['active', 'acknowledged'] },
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // últimas 24h
  });
  
  if (existing) {
    // Atualizar métricas do alerta existente
    existing.metrics = alertData.metrics;
    await existing.save();
    return existing;
  }
  
  // Criar novo alerta
  const alert = new Alert(alertData);
  await alert.save();
  
  // Aqui poderia disparar notificação (email, slack, etc)
  // await notifyNewAlert(alert);
  
  return alert;
}

/**
 * 📊 Retorna resumo de alertas para dashboard
 */
export async function getAlertsDashboard() {
  const stats = await Alert.getStats();
  const active = await Alert.getActiveByPriority();
  
  // Agrupar por página
  const byPage = {};
  active.forEach(alert => {
    if (!byPage[alert.landingPage]) {
      byPage[alert.landingPage] = [];
    }
    byPage[alert.landingPage].push(alert);
  });
  
  return {
    summary: {
      critical: stats.find(s => s._id === 'critical')?.count || 0,
      high: stats.find(s => s._id === 'high')?.count || 0,
      medium: stats.find(s => s._id === 'medium')?.count || 0,
      low: stats.find(s => s._id === 'low')?.count || 0,
      total: active.length
    },
    recent: active.slice(0, 10),
    byPage,
    needsAttention: Object.keys(byPage).length
  };
}

/**
 * 🎯 Retorna recomendações personalizadas por página
 */
export async function getRecommendationsForPage(slug) {
  const lp = await LandingPage.findOne({ slug });
  if (!lp) return null;
  
  const metrics = lp.metrics || {};
  const views = metrics.views || 0;
  const leads = metrics.leads || 0;
  const conversionRate = views > 0 ? (leads / views) : 0;
  
  const recommendations = [];
  
  // Recomendações baseadas em métricas
  if (conversionRate < 0.05 && views > 100) {
    recommendations.push({
      priority: 'high',
      issue: 'Baixa conversão',
      action: 'Revisar CTA e adicionar prova social',
      expectedImpact: '+30% conversão'
    });
  }
  
  if (views < 50) {
    recommendations.push({
      priority: 'high',
      issue: 'Baixo tráfego',
      action: 'Criar post GMB e Instagram linkando para esta página',
      expectedImpact: '+50 views/semana'
    });
  }
  
  if (leads > 0 && lp.postCount === 0) {
    recommendations.push({
      priority: 'medium',
      issue: 'Nunca usada em posts',
      action: 'Incluir em próximo post GMB',
      expectedImpact: 'Mais autoridade para a página'
    });
  }
  
  return {
    page: lp.slug,
    metrics: { views, leads, conversionRate: conversionRate * 100 },
    recommendations,
    score: calculatePageScore(metrics)
  };
}

/**
 * 🧮 Calcula score inteligente da página
 */
function calculatePageScore(metrics) {
  const views = metrics.views || 0;
  const leads = metrics.leads || 0;
  const conversionRate = views > 0 ? (leads / views) : 0;
  
  // Crescimento simulado (em produção viria de histórico)
  const growthRate = metrics.growthRate || 0;
  
  // Fórmula: conversionRate (50%) + leads (30%) + growthRate (20%)
  // Normalizando para escala 0-100
  const conversionScore = Math.min(conversionRate * 100 * 5, 50); // max 50 pontos
  const leadsScore = Math.min(leads * 3, 30); // max 30 pontos
  const growthScore = Math.max(0, Math.min(growthRate * 2, 20)); // max 20 pontos
  
  return Math.round(conversionScore + leadsScore + growthScore);
}

export default {
  analyzeAndGenerateAlerts,
  getAlertsDashboard,
  getRecommendationsForPage
};
