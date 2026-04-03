// back/routes/package.v2.js
/**
 * Package Routes V2 - CQRS Read API
 * 
 * Características:
 * - Só leitura (GET)
 * - Fallback inteligente (build on miss)
 * - Meta de performance
 * - Sem lógica de negócio (só orquestra)
 */

import express from 'express';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { formatSuccess, formatError } from '../utils/apiMessages.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import PackagesView from '../models/PackagesView.js';
import Package from '../models/Package.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import { buildPackageView } from '../domains/billing/services/PackageProjectionService.js';
import { handlePackageCreate } from '../domains/billing/workers/packageProcessingWorker.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';
import healthRoutes from './package.v2.health.js';

const router = express.Router();
const logger = createContextLogger('PackageV2');

// ============================================
// MIDDLEWARE: Parse de query params
// ============================================

function parseQueryOptions(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  
  return {
    page,
    limit,
    skip,
    status: req.query.status,
    type: req.query.type,
    sortBy: req.query.sortBy || 'snapshot.calculatedAt',
    sortOrder: req.query.sortOrder === 'asc' ? 1 : -1
  };
}

// ============================================
// POST /api/v2/packages
// Cria novo pacote (event-driven)
// ============================================

router.post('/', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `pkg_create_${Date.now()}`;
  const requestId = uuidv4();
  
  try {
    const {
      patientId,
      doctorId,
      specialty,
      sessionType,
      sessionValue,
      totalSessions,
      selectedSlots,
      paymentMethod,
      paymentType,
      type,
      notes,
      payments,
      date,
      durationMonths,
      sessionsPerWeek,
      calculationMode,
      appointmentId,
      liminarProcessNumber,
      liminarCourt,
      liminarExpirationDate,
      liminarMode,
      liminarAuthorized
    } = req.body;
    
    // Validação básica
    if (!patientId || !doctorId || !totalSessions) {
      return res.status(400).json(formatError(
        'Campos obrigatórios: patientId, doctorId, totalSessions',
        400,
        { correlationId }
      ));
    }
    
    logger.info('[PackageV2] Creating package', {
      correlationId,
      requestId,
      patientId,
      totalSessions
    });
    
    // Cria pacote de forma síncrona (garante read-your-writes)
    const createResult = await handlePackageCreate({
      patientId,
      doctorId,
      specialty,
      sessionType,
      sessionValue,
      totalSessions,
      selectedSlots,
      paymentMethod,
      paymentType,
      type: type || 'therapy',
      notes,
      payments,
      date,
      durationMonths,
      sessionsPerWeek,
      calculationMode,
      appointmentId,
      liminarProcessNumber,
      liminarCourt,
      liminarExpirationDate,
      liminarMode,
      liminarAuthorized,
      requestId,
      createdBy: req.user?._id
    }, correlationId);
    
    // Força build da projection para leitura imediata
    const buildResult = await buildPackageView(createResult.packageId, {
      correlationId,
      force: true
    });
    
    const duration = Date.now() - startTime;
    
    res.status(201).json(formatSuccess({
      package: buildResult.view,
      requestId,
      correlationId,
      status: 'created'
    }, {
      duration: `${duration}ms`
    }));
    
  } catch (error) {
    logger.error('[PackageV2] Error creating package', {
      correlationId,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json(formatError(error.message || 'Erro ao criar pacote', 500, { correlationId }));
  }
});

// ============================================
// GET /api/v2/packages
// Lista pacotes com filtros
// ============================================

router.get('/', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `pkg_list_${Date.now()}`;
  
  try {
    const options = parseQueryOptions(req);
    
    // Build query
    const query = {};
    if (options.status) query.status = options.status;
    if (options.type) query.type = options.type;
    
    // Se tem patientId no token/filtro, filtra
    if (req.query.patientId) {
      query.patientId = new mongoose.Types.ObjectId(req.query.patientId);
    }
    
    logger.info(`[${correlationId}] Listing packages`, { query, options });
    
    // Executa query
    const [packages, total] = await Promise.all([
      PackagesView.find(query)
        .sort({ [options.sortBy]: options.sortOrder })
        .skip(options.skip)
        .limit(options.limit)
        .lean(),
      PackagesView.countDocuments(query)
    ]);
    
    const duration = Date.now() - startTime;
    
    res.json(formatSuccess({
      packages,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        pages: Math.ceil(total / options.limit)
      },
      meta: {
        duration: `${duration}ms`,
        source: 'view',
        correlationId
      }
    }));
    
  } catch (error) {
    logger.error(`[${correlationId}] Error listing packages`, { error: error.message });
    res.status(500).json(formatError('Erro ao listar pacotes', 500, { correlationId }));
  }
});

// ============================================
// GET /api/v2/packages/:id
// Detalhe de um pacote (com fallback)
// ============================================

router.get('/:id', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `pkg_get_${Date.now()}`;
  const { id } = req.params;
  
  try {
    logger.info(`[${correlationId}] Getting package ${id}`);
    
    // 1. Tenta buscar na view
    let packageView = await PackagesView.findOne({ 
      $or: [
        { packageId: id },
        { _id: id }
      ]
    }).lean();
    
    // 2. FALLBACK: Se não achou, builda on-the-fly
    if (!packageView) {
      logger.info(`[${correlationId}] View not found, building on-the-fly`, { packageId: id });
      
      try {
        const buildResult = await buildPackageView(id, { correlationId });
        packageView = buildResult.view;
      } catch (buildError) {
        logger.error(`[${correlationId}] Failed to build view`, { error: buildError.message });
        return res.status(404).json(formatError('Pacote não encontrado', 404, { correlationId }));
      }
    }
    
    // 3. Verifica se está stale (loga warning mas retorna mesmo assim)
    if (packageView.snapshot?.isStale) {
      logger.warn(`[${correlationId}] Returning stale package view`, { packageId: id });
    }
    
    const duration = Date.now() - startTime;
    
    res.json(formatSuccess({
      package: packageView,
      meta: {
        duration: `${duration}ms`,
        source: packageView ? 'view' : 'build',
        isStale: packageView.snapshot?.isStale || false,
        version: packageView.snapshot?.version,
        correlationId
      }
    }));
    
  } catch (error) {
    logger.error(`[${correlationId}] Error getting package`, { error: error.message });
    res.status(500).json(formatError('Erro ao buscar pacote', 500, { correlationId }));
  }
});

// ============================================
// GET /api/v2/packages/patient/:patientId
// Lista pacotes de um paciente específico
// ============================================

router.get('/patient/:patientId', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `pkg_patient_${Date.now()}`;
  const { patientId } = req.params;
  
  try {
    const options = parseQueryOptions(req);
    
    logger.info(`[${correlationId}] Listing packages for patient ${patientId}`);
    
    // Query por paciente
    const query = { patientId: new mongoose.Types.ObjectId(patientId) };
    if (options.status) query.status = options.status;
    
    const [packages, total, stats] = await Promise.all([
      PackagesView.find(query)
        .sort({ [options.sortBy]: options.sortOrder })
        .skip(options.skip)
        .limit(options.limit)
        .lean(),
      PackagesView.countDocuments(query),
      PackagesView.getStats(patientId)
    ]);
    
    const duration = Date.now() - startTime;
    
    res.json(formatSuccess({
      packages,
      stats,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        pages: Math.ceil(total / options.limit)
      },
      meta: {
        duration: `${duration}ms`,
        source: 'view',
        correlationId
      }
    }));
    
  } catch (error) {
    logger.error(`[${correlationId}] Error listing patient packages`, { error: error.message });
    res.status(500).json(formatError('Erro ao listar pacotes do paciente', 500, { correlationId }));
  }
});

// ============================================
// GET /api/v2/packages/:id/debug
// Debug da view (compara com dados reais)
// ============================================

router.get('/:id/debug', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `pkg_debug_${Date.now()}`;
  const { id } = req.params;
  
  try {
    // Busca view atual
    const currentView = await PackagesView.findOne({ packageId: id }).lean();
    
    // Build fresh view
    const freshResult = await buildPackageView(id, { correlationId, force: true });
    
    // Compara
    const diff = [];
    if (currentView && freshResult.view) {
      const fields = ['status', 'sessionsUsed', 'sessionsRemaining', 'totalPaid'];
      fields.forEach(field => {
        if (currentView[field] !== freshResult.view[field]) {
          diff.push({
            field,
            current: currentView[field],
            fresh: freshResult.view[field]
          });
        }
      });
    }
    
    const duration = Date.now() - startTime;
    
    res.json(formatSuccess({
      currentView: currentView || null,
      freshView: {
        packageId: freshResult.view.packageId,
        status: freshResult.view.status,
        sessionsUsed: freshResult.view.sessionsUsed,
        sessionsRemaining: freshResult.view.sessionsRemaining
      },
      diff: {
        hasDiff: diff.length > 0,
        fields: diff
      },
      meta: {
        duration: `${duration}ms`,
        correlationId
      }
    }));
    
  } catch (error) {
    logger.error(`[${correlationId}] Error debugging package`, { error: error.message });
    res.status(500).json(formatError('Erro no debug', 500, { correlationId }));
  }
});

// ============================================
// PUT /api/v2/packages/:id
// Atualiza pacote (event-driven)
// ============================================

router.put('/:id', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `pkg_update_${Date.now()}`;
  const { id } = req.params;
  
  try {
    const updateData = req.body;
    
    // Validação: pacote existe
    const existing = await PackagesView.findOne({ packageId: id });
    if (!existing) {
      return res.status(404).json(formatError('Pacote não encontrado', 404, { correlationId }));
    }
    
    logger.info('[PackageV2] Updating package', { correlationId, packageId: id });
    
    // Publica evento para processamento assíncrono
    await publishEvent('PACKAGE_UPDATE_REQUESTED', {
      packageId: id,
      updates: updateData,
      updatedBy: req.user?._id
    }, { correlationId });
    
    const duration = Date.now() - startTime;
    
    res.status(202).json(formatSuccess({
      message: 'Atualização em processamento',
      packageId: id,
      correlationId,
      status: 'processing'
    }, {
      duration: `${duration}ms`
    }));
    
  } catch (error) {
    logger.error('[PackageV2] Error updating package', { correlationId, error: error.message });
    res.status(500).json(formatError('Erro ao atualizar pacote', 500, { correlationId }));
  }
});

// ============================================
// DELETE /api/v2/packages/:id
// Cancela/deleta pacote (event-driven)
// ============================================

router.delete('/:id', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `pkg_delete_${Date.now()}`;
  const { id } = req.params;
  
  try {
    logger.info('[PackageV2] Deleting package', { correlationId, packageId: id });

    const viewId = new mongoose.Types.ObjectId(id);

    // Busca a view para obter o packageId real do Package
    const view = await PackagesView.findById(viewId).lean();
    const realPackageId = view?.packageId || viewId; // fallback pro próprio id
    const pkgObjectId = new mongoose.Types.ObjectId(realPackageId);

    // Deleta tudo em paralelo usando o ID real do Package
    const [pkgResult, appointmentsResult, sessionsResult, paymentsResult] = await Promise.all([
      Package.findByIdAndDelete(pkgObjectId),
      Appointment.deleteMany({ package: pkgObjectId }),
      Session.deleteMany({ package: pkgObjectId }),
      Payment.deleteMany({ package: pkgObjectId })
    ]);

    // Remove a view pelo _id dela
    await PackagesView.findByIdAndDelete(viewId);

    const duration = Date.now() - startTime;

    logger.info('[PackageV2] Package deleted', {
      correlationId,
      packageId: id,
      found: !!pkgResult,
      appointments: appointmentsResult.deletedCount,
      sessions: sessionsResult.deletedCount,
      payments: paymentsResult.deletedCount
    });

    res.status(200).json(formatSuccess({
      packageId: id,
      deleted: true,
      counts: {
        appointments: appointmentsResult.deletedCount,
        sessions: sessionsResult.deletedCount,
        payments: paymentsResult.deletedCount
      }
    }, { duration: `${duration}ms` }));

  } catch (error) {
    logger.error('[PackageV2] Error deleting package', { correlationId, error: error.message });
    res.status(500).json(formatError('INTERNAL_ERROR', 'Erro ao deletar pacote', { correlationId }));
  }
});

// Health check
router.use('/health', healthRoutes);

// ============================================
// POST /api/v2/packages/:id/rebuild
// Força rebuild manual da PackagesView
// ============================================

router.post('/:id/rebuild', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const correlationId = `pkg_rebuild_${Date.now()}`;
  
  try {
    const result = await buildPackageView(id, { 
      correlationId, 
      force: true 
    });
    
    res.json(formatSuccess({
      packageId: id,
      view: {
        sessionsUsed: result.view.sessionsUsed,
        sessionsRemaining: result.view.sessionsRemaining,
        status: result.view.status
      },
      duration: result.duration
    }, {
      message: 'PackagesView reconstruída com sucesso',
      correlationId
    }));
  } catch (error) {
    res.status(500).json(formatError('Erro ao reconstruir view', 500, { 
      error: error.message,
      correlationId 
    }));
  }
}));

export default router;
