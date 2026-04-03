// back/routes/insuranceBatch.v2.js
/**
 * InsuranceBatch Routes V2 - CQRS Read API
 * 
 * Endpoints otimizados para consulta de lotes de convênio.
 * Usa InsuranceBatchView (read model) para leituras rápidas.
 * 
 * Endpoints:
 * - GET /api/v2/insurance-batches - Lista lotes
 * - GET /api/v2/insurance-batches/:id - Detalhe do lote
 * - GET /api/v2/insurance-batches/dashboard - Dashboard
 * - GET /api/v2/insurance-batches/metrics - Métricas por convênio
 */

import express from 'express';
import InsuranceBatchView from '../models/InsuranceBatchView.js';
import { buildInsuranceBatchView } from '../domains/billing/services/InsuranceBatchProjectionService.js';
import { flexibleAuth } from '../middleware/flexibleAuth.js';
import { createContextLogger } from '../utils/logger.js';
import insuranceBatchController from '../controllers/insuranceBatchController.js';

const router = express.Router();
const logger = createContextLogger('InsuranceBatchV2');

// Helper para resposta padronizada
const formatSuccess = (data, meta = {}) => ({
  success: true,
  data,
  meta: { timestamp: new Date().toISOString(), ...meta }
});

const formatError = (message, code = 500, details = {}) => ({
  success: false,
  error: { message, code, ...details }
});

// ============================================
// GET /api/v2/insurance-batches
// Lista lotes com filtros
// ============================================

router.get('/', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `ib_list_${Date.now()}`;

  try {
    const {
      page = 1,
      limit = 20,
      status,
      insuranceProvider,
      startDate,
      endDate
    } = req.query;

    logger.info(`[${correlationId}] Listing insurance batches`, {
      status,
      insuranceProvider,
      page
    });

    const result = await InsuranceBatchView.list({
      page: parseInt(page),
      limit: parseInt(limit),
      status,
      insuranceProvider,
      startDate,
      endDate
    });

    const duration = Date.now() - startTime;

    res.json(formatSuccess(result.batches, {
      correlationId,
      duration: `${duration}ms`,
      pagination: result.pagination
    }));

  } catch (error) {
    logger.error(`[${correlationId}] Error listing batches`, { error: error.message });
    res.status(500).json(formatError('Erro ao listar lotes', 500, { correlationId }));
  }
});

// ============================================
// GET /api/v2/insurance-batches/dashboard
// Dashboard de convênios
// ============================================

router.get('/dashboard', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `ib_dash_${Date.now()}`;

  try {
    const { insuranceProvider, startDate, endDate } = req.query;

    logger.info(`[${correlationId}] Generating dashboard`, { insuranceProvider });

    const dashboard = await InsuranceBatchView.getDashboard({
      insuranceProvider,
      startDate,
      endDate
    });

    const duration = Date.now() - startTime;

    res.json(formatSuccess(dashboard, {
      correlationId,
      duration: `${duration}ms`
    }));

  } catch (error) {
    logger.error(`[${correlationId}] Error generating dashboard`, { error: error.message });
    res.status(500).json(formatError('Erro ao gerar dashboard', 500, { correlationId }));
  }
});

// ============================================
// GET /api/v2/insurance-batches/metrics
// Métricas por convênio
// ============================================

router.get('/metrics', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `ib_metrics_${Date.now()}`;

  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json(formatError('startDate e endDate são obrigatórios', 400));
    }

    logger.info(`[${correlationId}] Generating metrics`, { startDate, endDate });

    const metrics = await InsuranceBatchView.getMetricsByProvider(startDate, endDate);

    const duration = Date.now() - startTime;

    res.json(formatSuccess(metrics, {
      correlationId,
      duration: `${duration}ms`,
      period: { startDate, endDate }
    }));

  } catch (error) {
    logger.error(`[${correlationId}] Error generating metrics`, { error: error.message });
    res.status(500).json(formatError('Erro ao gerar métricas', 500, { correlationId }));
  }
});

// ============================================
// GET /api/v2/insurance-batches/:id
// Detalhe do lote
// ============================================

router.get('/:id', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `ib_detail_${Date.now()}`;
  const { id } = req.params;

  try {
    logger.info(`[${correlationId}] Getting batch details`, { batchId: id });

    // Tenta pela view primeiro
    let batch = await InsuranceBatchView.findOne({
      $or: [{ batchId: id }, { _id: id }]
    }).lean();

    let source = 'view';

    // Fallback: build sync se não encontrar
    if (!batch) {
      logger.info(`[${correlationId}] View not found, building sync`, { batchId: id });
      
      const buildResult = await buildInsuranceBatchView(id, { correlationId });
      
      if (buildResult?.view) {
        batch = buildResult.view.toObject();
        source = 'build_sync';
      }
    }

    if (!batch) {
      return res.status(404).json(formatError('Lote não encontrado', 404, { correlationId }));
    }

    const duration = Date.now() - startTime;

    res.json(formatSuccess(batch, {
      correlationId,
      duration: `${duration}ms`,
      source
    }));

  } catch (error) {
    logger.error(`[${correlationId}] Error getting batch`, { batchId: id, error: error.message });
    res.status(500).json(formatError('Erro ao buscar lote', 500, { correlationId }));
  }
});

// ============================================
// POST /api/v2/insurance-batches/:id/rebuild
// Rebuild manual da view
// ============================================

router.post('/:id/rebuild', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `ib_rebuild_${Date.now()}`;
  const { id } = req.params;

  try {
    logger.info(`[${correlationId}] Rebuilding batch view`, { batchId: id });

    const result = await buildInsuranceBatchView(id, { correlationId });

    if (!result?.view) {
      return res.status(404).json(formatError('Lote não encontrado para rebuild', 404));
    }

    const duration = Date.now() - startTime;

    res.json(formatSuccess({
      message: 'View reconstruída com sucesso',
      batchId: id,
      viewVersion: result.view.snapshot?.version
    }, {
      correlationId,
      duration: `${duration}ms`
    }));

  } catch (error) {
    logger.error(`[${correlationId}] Error rebuilding batch`, { batchId: id, error: error.message });
    res.status(500).json(formatError('Erro ao reconstruir view', 500, { correlationId }));
  }
});

// ============================================
// GET /api/v2/insurance-batches/consistency/check
// Verifica consistência entre write model e view
// ============================================

router.get('/consistency/check', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `ib_consistency_${Date.now()}`;

  try {
    logger.info(`[${correlationId}] Checking consistency`);

    const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;

    // Contagens
    const [writeCount, viewCount] = await Promise.all([
      InsuranceBatch.countDocuments(),
      InsuranceBatchView.countDocuments()
    ]);

    // Verifica divergências de status
    const writeStatusCounts = await InsuranceBatch.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const viewStatusCounts = await InsuranceBatchView.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    // Lotes sem view
    const writeIds = await InsuranceBatch.find().select('_id').lean();
    const writeIdSet = new Set(writeIds.map(d => d._id.toString()));
    
    const viewIds = await InsuranceBatchView.find().select('batchId').lean();
    const viewIdSet = new Set(viewIds.map(d => d.batchId));

    const missingInView = [...writeIdSet].filter(id => !viewIdSet.has(id));
    const orphanedInView = [...viewIdSet].filter(id => !writeIdSet.has(id));

    const duration = Date.now() - startTime;

    const isConsistent = missingInView.length === 0 && orphanedInView.length === 0 && writeCount === viewCount;

    res.json(formatSuccess({
      isConsistent,
      counts: {
        writeModel: writeCount,
        viewModel: viewCount,
        difference: writeCount - viewCount
      },
      statusDistribution: {
        write: writeStatusCounts.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
        view: viewStatusCounts.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {})
      },
      issues: {
        missingInView: missingInView.length,
        orphanedInView: orphanedInView.length,
        missingIds: missingInView.slice(0, 10), // Limita a 10
        orphanedIds: orphanedInView.slice(0, 10)
      }
    }, {
      correlationId,
      duration: `${duration}ms`
    }));

  } catch (error) {
    logger.error(`[${correlationId}] Error checking consistency`, { error: error.message });
    res.status(500).json(formatError('Erro ao verificar consistência', 500, { correlationId }));
  }
});

// ============================================
// ROTAS V2 - FATURAMENTO DE CONVÊNIO
// ============================================

// POST /api/v2/insurance-batches - Criar lote
router.post('/', flexibleAuth, insuranceBatchController.createBatch);

// POST /api/v2/insurance-batches/:id/send - Enviar lote
router.post('/:id/send', flexibleAuth, insuranceBatchController.sendBatch);

// POST /api/v2/insurance-batches/:id/return - Processar retorno
router.post('/:id/return', flexibleAuth, insuranceBatchController.processReturn);

// GET /api/v2/insurance-batches/:id - Detalhes (usando controller)
router.get('/:id/detail', flexibleAuth, insuranceBatchController.getBatchById);

export default router;
