/**
 * 🎯 Cron de Cálculo Diário de Scores
 * Executa todo dia às 6h da manhã para atualizar scores de todas as landing pages
 */

import cron from 'node-cron';
import LandingPage from '../models/LandingPage.js';
import Leads from '../models/Leads.js';
import * as scoringService from '../services/intelligentScoringService.js';
import * as alertService from '../services/alertService.js';
import Logger from '../services/utils/Logger.js';

const logger = new Logger('DailyScoringCron');

// Flag para evitar execução simultânea
let isRunning = false;

/**
 * Calcula scores para todas as landing pages
 */
export async function calculateDailyScores() {
  if (isRunning) {
    logger.warn('CRON_ALREADY_RUNNING', { timestamp: new Date() });
    return { success: false, reason: 'already_running' };
  }

  isRunning = true;
  const startTime = Date.now();
  
  try {
    logger.info('DAILY_SCORING_START', { timestamp: new Date() });

    const landingPages = await LandingPage.find({}).lean();
    const period = 30; // Últimos 30 dias
    const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

    const results = [];
    const alertsToCreate = [];

    for (const lp of landingPages) {
      try {
        // Buscar dados de leads e interações
        const [leads, interactions] = await Promise.all([
          Leads.find({
            landingPage: { $regex: lp.slug, $options: 'i' },
            createdAt: { $gte: since }
          }).lean(),
          Leads.find({
            landingPage: { $regex: lp.slug, $options: 'i' },
            'journeyTimeline.timestamp': { $gte: since }
          }).select('journeyTimeline').lean()
        ]);

        const lpData = {
          ...lp,
          leads,
          visits: [], // TODO: Integrar com Visitas quando existir
          interactions: interactions.flatMap(i => i.journeyTimeline || [])
        };

        const score = await scoringService.calculateLandingPageScore(lpData, period);

        // Atualizar no banco
        await LandingPage.findByIdAndUpdate(lp._id, {
          $set: {
            'metadata.lpScore': score.score,
            'metadata.lpScoreGrade': score.grade,
            'metadata.scoreCalculatedAt': new Date(),
            'metadata.lastMetrics': score.metrics
          }
        });

        results.push({
          slug: lp.slug,
          success: true,
          score: score.score,
          grade: score.grade,
          alerts: score.analysis.alerts.length
        });

        // Criar alertas se necessário
        for (const alert of score.analysis.alerts) {
          if (alert.severity === 'high' || alert.severity === 'critical') {
            alertsToCreate.push({
              tipo: alert.type,
              prioridade: alert.severity,
              titulo: alert.message,
              mensagem: alert.message,
              landingPage: lp.slug,
              dados: {
                metric: alert.type,
                value: score.metrics[alert.type],
                threshold: alert.threshold,
                score: score.score
              }
            });
          }
        }

      } catch (err) {
        logger.error('SCORING_ERROR', { slug: lp.slug, error: err.message });
        results.push({
          slug: lp.slug,
          success: false,
          error: err.message
        });
      }
    }

    // Criar alertas em batch
    if (alertsToCreate.length > 0) {
      for (const alertData of alertsToCreate) {
        await alertService.criarAlerta(alertData);
      }
      logger.info('ALERTS_CREATED', { count: alertsToCreate.length });
    }

    const duration = Date.now() - startTime;
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    logger.info('DAILY_SCORING_COMPLETE', {
      duration,
      total: landingPages.length,
      successful,
      failed,
      alertsCreated: alertsToCreate.length
    });

    return {
      success: true,
      timestamp: new Date(),
      duration,
      summary: {
        total: landingPages.length,
        successful,
        failed,
        alertsCreated: alertsToCreate.length
      },
      results
    };

  } catch (error) {
    logger.error('DAILY_SCORING_FATAL_ERROR', { error: error.message });
    return {
      success: false,
      error: error.message
    };
  } finally {
    isRunning = false;
  }
}

/**
 * Agenda o cron job
 * Executa todo dia às 6h da manhã
 */
export function scheduleDailyScoring() {
  // '0 6 * * *' = 6:00 AM todos os dias
  cron.schedule('0 6 * * *', async () => {
    logger.info('CRON_TRIGGERED', { scheduledTime: '06:00' });
    await calculateDailyScores();
  }, {
    scheduled: true,
    timezone: 'America/Sao_Paulo'
  });

  logger.info('DAILY_SCORING_SCHEDULED', { time: '06:00', timezone: 'America/Sao_Paulo' });
}

/**
 * Executa imediatamente (para testes ou inicialização)
 */
export async function runScoringNow() {
  return await calculateDailyScores();
}

export default {
  calculateDailyScores,
  scheduleDailyScoring,
  runScoringNow
};
