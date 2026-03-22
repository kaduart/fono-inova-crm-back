/**
 * 🚨 Rotas para Sistema de Alertas
 * Alertas de performance e anomalias das landing pages
 */

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import Alert from '../models/Alert.js';
import * as alertService from '../services/alertService.js';

const router = Router();

router.use(auth);

/**
 * GET /api/alerts
 * Lista todos os alertas com filtros opcionais
 */
router.get('/', async (req, res) => {
  try {
    const {
      status = 'active',
      prioridade,
      categoria,
      landingPage,
      limit = 50,
      offset = 0
    } = req.query;

    const query = {};
    if (status === 'active') query.status = { $in: ['novo', 'lido'] };
    if (status === 'resolved') query.status = 'resolvido';
    if (status === 'all') delete query.status;
    if (prioridade) query.prioridade = prioridade;
    if (categoria) query.categoria = categoria;
    if (landingPage) query.landingPage = landingPage;

    const alerts = await Alert.find(query)
      .sort({ criadoEm: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .lean();

    const total = await Alert.countDocuments(query);

    res.json({
      success: true,
      data: alerts,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
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
 * GET /api/alerts/dashboard
 * Dashboard de alertas com métricas
 */
router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await alertService.getDashboardResumo();
    res.json({
      success: true,
      data: dashboard
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/:id
 * Detalhes de um alerta específico
 */
router.get('/:id', async (req, res) => {
  try {
    const alert = await Alert.findById(req.params.id).lean();
    
    if (!alert) {
      return res.status(404).json({
        success: false,
        error: 'Alerta não encontrado'
      });
    }

    res.json({
      success: true,
      data: alert
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/alerts
 * Cria um novo alerta manualmente
 */
router.post('/', async (req, res) => {
  try {
    const alerta = await alertService.criarAlerta(req.body);
    
    res.status(201).json({
      success: true,
      data: alerta
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/:id/ack
 * Marca alerta como lido/reconhecido
 */
router.post('/:id/ack', async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(
      req.params.id,
      { 
        $set: { 
          status: 'lido',
          lidoEm: new Date(),
          lidoPor: req.user?.id || req.user?._id
        }
      },
      { new: true }
    );

    if (!alert) {
      return res.status(404).json({
        success: false,
        error: 'Alerta não encontrado'
      });
    }

    res.json({
      success: true,
      data: alert
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/:id/resolve
 * Marca alerta como resolvido
 */
router.post('/:id/resolve', async (req, res) => {
  try {
    const { resolucao } = req.body;
    
    const alert = await Alert.findByIdAndUpdate(
      req.params.id,
      { 
        $set: { 
          status: 'resolvido',
          resolvidoEm: new Date(),
          resolvidoPor: req.user?.id || req.user?._id,
          resolucao: resolucao || 'Resolvido manualmente'
        }
      },
      { new: true }
    );

    if (!alert) {
      return res.status(404).json({
        success: false,
        error: 'Alerta não encontrado'
      });
    }

    res.json({
      success: true,
      data: alert
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/alerts/:id
 * Remove um alerta
 */
router.delete('/:id', async (req, res) => {
  try {
    const alert = await Alert.findByIdAndDelete(req.params.id);

    if (!alert) {
      return res.status(404).json({
        success: false,
        error: 'Alerta não encontrado'
      });
    }

    res.json({
      success: true,
      message: 'Alerta removido com sucesso'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/by-landing-page/:slug
 * Alertas específicos de uma landing page
 */
router.get('/by-landing-page/:slug', async (req, res) => {
  try {
    const alerts = await Alert.find({
      landingPage: req.params.slug,
      status: { $in: ['novo', 'lido'] }
    })
      .sort({ criadoEm: -1 })
      .lean();

    res.json({
      success: true,
      data: alerts
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
