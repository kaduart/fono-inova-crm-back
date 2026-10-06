/**
 * 🛤️ Rotas para Journey Tracking
 * Rastreamento completo da jornada do lead
 */

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import Leads from '../models/Leads.js';
import * as journeyService from '../services/leadJourneyService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = Router();

// Rotas públicas (para tracking do frontend)
router.post('/track', journeyService.journeyTrackingMiddleware(), async (req, res) => {
  try {
    const { type, page, metadata } = req.body;
    
    if (req.journey?.journeyId) {
      await journeyService.trackInteraction(req.journey.journeyId, {
        type: type || 'page_view',
        page: page || req.body.page,
        metadata: metadata || {}
      });
    }

    res.json({
      success: true,
      journeyId: req.journey?.journeyId,
      sessionId: req.journey?.sessionId
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

router.post('/identify', journeyService.journeyTrackingMiddleware(), async (req, res) => {
  try {
    const { name, email, phone, ...otherData } = req.body;
    
    if (!req.journey?.journeyId) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Journey não iniciada', { status: 400 }), req);
    }

    const lead = await journeyService.identifyLead(req.journey.journeyId, {
      name,
      email,
      phone,
      ...otherData
    });

    res.json({
      success: true,
      data: lead
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

// Rotas protegidas (requerem autenticação)
router.use(auth);

/**
 * GET /api/journey/:journeyId
 * Retorna jornada completa
 */
router.get('/:journeyId', async (req, res) => {
  try {
    const journey = await journeyService.getLeadJourney(req.params.journeyId);
    
    if (!journey) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Jornada não encontrada', { status: 404 }), req);
    }

    res.json({
      success: true,
      data: journey
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

/**
 * GET /api/journey/lead/:identifier
 * Busca jornada por identificador (phone, email, journeyId)
 */
router.get('/lead/:identifier', async (req, res) => {
  try {
    const journey = await journeyService.getJourneyByIdentifier(req.params.identifier);
    
    if (!journey) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Jornada não encontrada', { status: 404 }), req);
    }

    res.json({
      success: true,
      data: journey
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

/**
 * GET /api/journey/analytics/summary
 * Resumo de analytics de jornadas
 */
router.get('/analytics/summary', async (req, res) => {
  try {
    const { period = 30 } = req.query;
    const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

    const [
      totalJourneys,
      identifiedLeads,
      whatsappClicks,
      bySource
    ] = await Promise.all([
      Leads.countDocuments({ createdAt: { $gte: since } }),
      Leads.countDocuments({ 
        createdAt: { $gte: since },
        isIdentified: true 
      }),
      Leads.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$whatsappClicks' } } }
      ]),
      Leads.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    res.json({
      success: true,
      data: {
        period,
        totalJourneys,
        identifiedLeads,
        identificationRate: totalJourneys > 0 ? (identifiedLeads / totalJourneys) : 0,
        whatsappClicks: whatsappClicks[0]?.total || 0,
        bySource: bySource.map(s => ({ source: s._id, count: s.count }))
      }
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

/**
 * GET /api/journey/analytics/funnel
 * Análise de funil de conversão
 */
router.get('/analytics/funnel', async (req, res) => {
  try {
    const { period = 30 } = req.query;
    const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

    const funnel = await Leads.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pageViews: { $sum: '$pageViews' },
          whatsappClicks: { $sum: '$whatsappClicks' },
          formStarts: {
            $sum: {
              $cond: [{ $eq: ['$hasStartedForm', true] }, 1, 0]
            }
          },
          formSubmissions: {
            $sum: {
              $cond: [{ $eq: ['$hasSubmittedForm', true] }, 1, 0]
            }
          },
          identified: {
            $sum: {
              $cond: [{ $eq: ['$isIdentified', true] }, 1, 0]
            }
          }
        }
      }
    ]);

    res.json({
      success: true,
      data: funnel[0] || {
        total: 0,
        pageViews: 0,
        whatsappClicks: 0,
        formStarts: 0,
        formSubmissions: 0,
        identified: 0
      }
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

/**
 * GET /api/journey/by-page/:page
 * Jornadas de uma página específica
 */
router.get('/by-page/:page', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const page = '/' + req.params.page;

    const journeys = await Leads.find({
      $or: [
        { landingPage: page },
        { lastPage: page },
        { 'pagesVisited.url': page }
      ]
    })
      .sort({ createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .select('journeyId name email phone source landingPage createdAt isIdentified')
      .lean();

    const total = await Leads.countDocuments({
      $or: [
        { landingPage: page },
        { lastPage: page },
        { 'pagesVisited.url': page }
      ]
    });

    res.json({
      success: true,
      data: journeys,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

export default router;
