/**
 * 🎯 Rotas para Intelligent Scoring
 * Scores e rankings de landing pages
 */

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import LandingPage from '../models/LandingPage.js';
import Leads from '../models/Leads.js';
import * as scoringService from '../services/intelligentScoringService.js';
import * as recommendationsService from '../services/recommendationsService.js';

const router = Router();

router.use(auth);

/**
 * GET /api/scoring/ranking
 * Ranking completo de todas as landing pages
 */
router.get('/ranking', async (req, res) => {
  try {
    const { period = 30 } = req.query;

    // Buscar todas as landing pages com dados
    const landingPages = await LandingPage.find({}).lean();
    
    // Enriquecer com dados de leads e visits
    const enrichedData = await Promise.all(
      landingPages.map(async (lp) => {
        const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);
        
        const [leads, visits, interactions] = await Promise.all([
          Leads.find({
            landingPage: { $regex: lp.slug, $options: 'i' },
            createdAt: { $gte: since }
          }).lean(),
          // TODO: Integrar com modelo de Visitas quando existir
          [],
          Leads.find({
            landingPage: { $regex: lp.slug, $options: 'i' },
            'journeyTimeline.timestamp': { $gte: since }
          }).select('journeyTimeline').lean()
        ]);

        return {
          ...lp,
          leads,
          visits,
          interactions: interactions.flatMap(i => i.journeyTimeline || [])
        };
      })
    );

    const ranking = await scoringService.calculateMultipleScores(enrichedData, parseInt(period));

    res.json({
      success: true,
      data: ranking
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/scoring/landing-page/:slug
 * Score de uma landing page específica
 */
router.get('/landing-page/:slug', async (req, res) => {
  try {
    const { period = 30 } = req.query;
    const { slug } = req.params;

    const lp = await LandingPage.findOne({ slug }).lean();
    
    if (!lp) {
      return res.status(404).json({
        success: false,
        error: 'Landing page não encontrada'
      });
    }

    const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);
    
    const [leads, interactions] = await Promise.all([
      Leads.find({
        landingPage: { $regex: slug, $options: 'i' },
        createdAt: { $gte: since }
      }).lean(),
      Leads.find({
        landingPage: { $regex: slug, $options: 'i' },
        'journeyTimeline.timestamp': { $gte: since }
      }).select('journeyTimeline').lean()
    ]);

    const lpData = {
      ...lp,
      leads,
      visits: [], // TODO: Integrar com Visitas
      interactions: interactions.flatMap(i => i.journeyTimeline || [])
    };

    const score = await scoringService.calculateLandingPageScore(lpData, parseInt(period));

    res.json({
      success: true,
      data: score
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/scoring/recommendations
 * Recomendações para todas as landing pages
 */
router.get('/recommendations', async (req, res) => {
  try {
    const { template = 'detailed' } = req.query;

    const landingPages = await LandingPage.find({}).lean();
    const report = await recommendationsService.generateReport(landingPages, { template });

    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/scoring/priorities
 * Prioridades do dia
 */
router.get('/priorities', async (req, res) => {
  try {
    const landingPages = await LandingPage.find({}).lean();
    const priorities = recommendationsService.generateDailyPriorities(landingPages);

    res.json({
      success: true,
      data: priorities
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/scoring/landing-page/:slug/recommendations
 * Recomendações específicas para uma LP
 */
router.get('/landing-page/:slug/recommendations', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const lp = await LandingPage.findOne({ slug }).lean();
    
    if (!lp) {
      return res.status(404).json({
        success: false,
        error: 'Landing page não encontrada'
      });
    }

    const analysis = recommendationsService.detectIssuesAndOpportunities(lp);

    res.json({
      success: true,
      data: {
        slug,
        ...analysis,
        recommendations: recommendationsService.generateRecommendations?.(analysis, lp.metrics) || []
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/scoring/calculate
 * Recalcula scores manualmente
 */
router.post('/calculate', async (req, res) => {
  try {
    const { slug, period = 30 } = req.body;

    if (slug) {
      // Recalcular uma LP específica
      const lp = await LandingPage.findOne({ slug }).lean();
      
      if (!lp) {
        return res.status(404).json({
          success: false,
          error: 'Landing page não encontrada'
        });
      }

      const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);
      const [leads, interactions] = await Promise.all([
        Leads.find({
          landingPage: { $regex: slug, $options: 'i' },
          createdAt: { $gte: since }
        }).lean(),
        Leads.find({
          landingPage: { $regex: slug, $options: 'i' },
          'journeyTimeline.timestamp': { $gte: since }
        }).select('journeyTimeline').lean()
      ]);

      const lpData = {
        ...lp,
        leads,
        visits: [],
        interactions: interactions.flatMap(i => i.journeyTimeline || [])
      };

      const score = await scoringService.calculateLandingPageScore(lpData, period);

      // Atualizar no banco
      await LandingPage.findByIdAndUpdate(lp._id, {
        $set: {
          'metadata.lpScore': score.score,
          'metadata.lpScoreGrade': score.grade,
          'metadata.scoreCalculatedAt': new Date()
        }
      });

      return res.json({
        success: true,
        data: score
      });
    }

    // Recalcular todas
    const landingPages = await LandingPage.find({}).lean();
    
    const results = await Promise.all(
      landingPages.map(async (lp) => {
        try {
          const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);
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
            visits: [],
            interactions: interactions.flatMap(i => i.journeyTimeline || [])
          };

          const score = await scoringService.calculateLandingPageScore(lpData, period);
          
          await LandingPage.findByIdAndUpdate(lp._id, {
            $set: {
              'metadata.lpScore': score.score,
              'metadata.lpScoreGrade': score.grade,
              'metadata.scoreCalculatedAt': new Date()
            }
          });

          return { slug: lp.slug, success: true, score: score.score };
        } catch (err) {
          return { slug: lp.slug, success: false, error: err.message };
        }
      })
    );

    res.json({
      success: true,
      data: {
        processed: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/scoring/forecast/:slug
 * Previsão de crescimento
 */
router.get('/forecast/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { periods = 4 } = req.query;

    // Buscar dados históricos (últimos meses)
    const historicalData = await Leads.aggregate([
      {
        $match: {
          landingPage: { $regex: slug, $options: 'i' },
          createdAt: { $gte: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            week: { $week: '$createdAt' }
          },
          leads: { $sum: 1 },
          date: { $min: '$createdAt' }
        }
      },
      { $sort: { date: 1 } }
    ]);

    const forecast = scoringService.calculateGrowthTrend(
      historicalData.map(h => ({ date: h.date, leads: h.leads })),
      parseInt(periods)
    );

    res.json({
      success: true,
      data: {
        slug,
        historical: historicalData,
        forecast
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
