// back/routes/patient.v2.js
/**
 * 🚀 ROTAS V2 - Patients (CQRS COMPLETO)
 * 
 * READ: PatientsView (snapshot) com fallback inteligente
 * WRITE: Event-driven (async)
 * 
 * Garantias:
 * - Read: sempre retorna dados (view ou fallback)
 * - Staleness: detectado e corrigido em background
 * - Observabilidade: logs e métricas em todos os pontos
 */

import express from 'express';
import mongoose from 'mongoose';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { formatSuccess, formatError } from '../utils/apiMessages.js';
import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import { buildPatientView } from '../domains/clinical/services/patientProjectionService.js';
import { getProjectionWorkerStatus, getProjectionMetrics } from '../domains/clinical/workers/patientProjectionWorker.js';
import patientV2DebugRoutes from './patient.v2.debug.js';
import { createContextLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createContextLogger('PatientV2Routes');

// ============================================
// CONFIG
// ============================================

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutos
const VIEW_TIMEOUT_MS = 3000; // 3s para build sync

// ============================================
// READ SIDE (PatientsView + fallback)
// ============================================

/**
 * 🎯 GET /api/v2/patients - Listagem RÁPIDA
 * 
 * Performance: 10-50ms (vs 150-500ms do V1)
 * Usa PatientsView com índices otimizados
 */
router.get('/', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = req.headers['x-correlation-id'] || `pat_list_${Date.now()}`;
  
  try {
    const { 
      search, 
      limit = 50, 
      skip = 0,
      doctorId = null,
      status = null,
      includeStale = 'false' // se 'true', inclui views stale
    } = req.query;
    
    logger.info(`[${correlationId}] 📋 List patients`, {
      search: search?.substring(0, 50),
      limit,
      skip,
      doctorId
    });
    
    // 🚀 Query otimizada no PatientsView
    const result = await PatientsView.quickSearch(search, {
      limit: parseInt(limit),
      skip: parseInt(skip),
      doctorId,
      status
    });
    
    const duration = Date.now() - startTime;
    const staleCount = result.patients.filter(p => p.snapshot?.isStale).length;
    
    // Se tem views stale e não estamos incluindo, dispara rebuild em background
    if (staleCount > 0 && includeStale !== 'true') {
      logger.warn(`[${correlationId}] ⚠️ ${staleCount} views stale detectadas`);
      
      // Dispara rebuild em background (não await)
      result.patients
        .filter(p => p.snapshot?.isStale)
        .slice(0, 10) // max 10 por request
        .forEach(p => {
          publishEvent('PATIENT_VIEW_REBUILD_REQUESTED', {
            patientId: p.patientId.toString(),
            reason: 'stale_detected_in_list'
          }, { correlationId });
        });
    }
    
    logger.info(`[${correlationId}] ✅ List completed`, {
      count: result.patients.length,
      total: result.total,
      duration: `${duration}ms`,
      staleCount
    });
    
    return res.json(formatSuccess({
      patients: result.patients,
      pagination: {
        total: result.total,
        limit: result.limit,
        skip: result.skip,
        hasMore: result.skip + result.patients.length < result.total
      },
      meta: {
        source: 'patients_view',
        duration: `${duration}ms`,
        staleCount: includeStale === 'true' ? staleCount : undefined
      }
    }));
    
  } catch (error) {
    logger.error(`[${correlationId}] ❌ List error`, { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * GET /api/v2/patients/:id - Detalhe com FALLBACK INTELIGENTE
 * 
 * Estratégia:
 * 1. Tenta PatientsView (rápido)
 * 2. Se não existe → build sync (demora, mas funciona)
 * 3. Se está stale → retorna + rebuild background
 */
router.get('/:id', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const { id } = req.params;
  const correlationId = req.headers['x-correlation-id'] || `pat_get_${Date.now()}`;
  
  logger.info(`[${correlationId}] 🔍 Get patient`, { patientId: id });
  
  try {
    let view = null;
    let source = 'view';
    let isStale = false;
    let fallbackTriggered = false;
    
    // 1. Tenta buscar na View (por patientId ou _id da própria view)
    view = await PatientsView.findOne({ $or: [{ patientId: id }, { _id: id }] }).lean();
    // Resolve o patientId real caso tenha chegado o _id da view
    const resolvedPatientId = view?.patientId || id;

    // 2. Se não existe → FALLBACK: build sync
    if (!view) {
      logger.warn(`[${correlationId}] ⚠️ View not found, triggering sync build`, { patientId: resolvedPatientId });

      // Verifica se paciente existe no domínio
      const patientExists = await Patient.exists({ _id: resolvedPatientId });
      if (!patientExists) {
        logger.info(`[${correlationId}] ❌ Patient not found in domain`, { patientId: resolvedPatientId });
        return res.status(404).json(formatError('Paciente não encontrado', 404));
      }

      // Build sync com timeout
      try {
        const buildPromise = buildPatientView(resolvedPatientId, {
          correlationId,
          force: true 
        });
        
        // Race com timeout
        view = await Promise.race([
          buildPromise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('BUILD_TIMEOUT')), VIEW_TIMEOUT_MS)
          )
        ]);
        
        // ✅ FIX P0: Se build retornou null (paciente não existe ou erro silencioso)
        if (!view) {
          logger.warn(`[${correlationId}] ⚠️ Build returned null, trying raw fallback`, { patientId: id });
          throw new Error('BUILD_RETURNED_NULL');
        }
        
        source = 'build_sync';
        fallbackTriggered = true;
        
        logger.info(`[${correlationId}] ✅ Sync build completed`, { patientId: resolvedPatientId });

      } catch (buildError) {
        // Timeout ou erro no build
        logger.error(`[${correlationId}] ❌ Sync build failed`, {
          patientId: resolvedPatientId,
          error: buildError.message
        });

        // Último recurso: retorna dados crus do Patient
        const patient = await Patient.findById(resolvedPatientId).lean();
        if (patient) {
          logger.info(`[${correlationId}] ⚠️ Returning raw patient data`, { patientId: resolvedPatientId });
          
          const duration = Date.now() - startTime;
          return res.json(formatSuccess({
            ...patient,
            _id: patient._id.toString(),
            patientId: patient._id.toString(),
            snapshot: {
              source: 'raw_patient_fallback',
              warning: 'View não disponível, dados podem estar desatualizados'
            }
          }, null, 200, {
            meta: {
              duration: `${duration}ms`,
              source: 'raw_fallback',
              buildError: buildError.message
            }
          }));
        }
        
        return res.status(500).json(formatError('Erro ao carregar paciente', 500));
      }
    }
    
    // 3. Se existe mas está stale → retorna + rebuild background
    if (view && view.snapshot) {
      const age = Date.now() - new Date(view.snapshot.calculatedAt).getTime();
      isStale = age > STALE_THRESHOLD_MS;
      
      if (isStale) {
        logger.warn(`[${correlationId}] ⚠️ View is stale (${Math.round(age / 1000)}s)`, { patientId: resolvedPatientId });

        // Dispara rebuild em background (não await)
        publishEvent('PATIENT_VIEW_REBUILD_REQUESTED', {
          patientId: resolvedPatientId,
          reason: `stale_view_accessed (age: ${Math.round(age / 1000)}s)`
        }, { correlationId });
      }
    }
    
    const duration = Date.now() - startTime;
    
    logger.info(`[${correlationId}] ✅ Get completed`, {
      patientId: id,
      source,
      duration: `${duration}ms`,
      isStale,
      fallbackTriggered
    });
    
    return res.json(formatSuccess(view, null, 200, {
      meta: {
        duration: `${duration}ms`,
        source,
        isStale,
        fallbackTriggered,
        viewVersion: view.snapshot?.version
      }
    }));
    
  } catch (error) {
    logger.error(`[${correlationId}] ❌ Get error`, { patientId: id, error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * GET /api/v2/patients/dashboard-stats
 * Métricas agregadas (usando PatientsView)
 */
router.get('/dashboard/stats', flexibleAuth, async (req, res) => {
  try {
    const { doctorId } = req.query;
    const stats = await PatientsView.getDashboardStats(doctorId);
    
    return res.json(formatSuccess(stats[0] || {
      totalPatients: 0,
      activePatients: 0,
      totalRevenue: 0,
      totalPending: 0,
      avgSessionsPerPatient: 0
    }));
    
  } catch (error) {
    logger.error('Dashboard stats error', { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

// ============================================
// WRITE SIDE (event-driven, async)
// ============================================

/**
 * 🎯 POST /api/v2/patients - Criar (ASYNC)
 * 
 * 202 Accepted → evento → worker → PatientsView
 */
router.post('/', flexibleAuth, async (req, res) => {
  const correlationId = `pat_create_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { fullName, dateOfBirth } = req.body;
    
    // Validação síncrona (fail fast)
    if (!fullName || !dateOfBirth) {
      return res.status(400).json(
        formatError('Nome completo e data de nascimento são obrigatórios', 400)
      );
    }
    
    // Gera ID provisório
    const patientId = new mongoose.Types.ObjectId().toString();
    
    logger.info(`[${correlationId}] 🆕 Create patient requested`, {
      patientId,
      fullName: fullName.substring(0, 50)
    });
    
    // Publica evento
    const event = await publishEvent(
      EventTypes.PATIENT_CREATE_REQUESTED,
      {
        patientId,
        fullName: fullName.trim(),
        dateOfBirth,
        phone: req.body.phone?.replace(/\D/g, ''),
        email: req.body.email?.toLowerCase(),
        cpf: req.body.cpf?.replace(/\D/g, ''),
        rg: req.body.rg,
        gender: req.body.gender,
        address: req.body.address,
        healthPlan: req.body.healthPlan,
        mainComplaint: req.body.mainComplaint,
        emergencyContact: req.body.emergencyContact,
        createdBy: req.user?.id,
        createdAt: new Date().toISOString()
      },
      { correlationId }
    );
    
    logger.info(`[${correlationId}] ✅ Event published`, {
      eventId: event.eventId,
      patientId
    });
    
    return res.status(202).json(
      formatSuccess({
        eventId: event.eventId,
        correlationId,
        jobId: event.jobId,
        patientId,
        status: 'pending',
        checkStatusUrl: `/api/v2/patients/status/${event.eventId}`,
        estimatedTime: '1-2s'
      }, { message: 'Paciente em processamento' })
    );
    
  } catch (error) {
    logger.error(`[${correlationId}] ❌ Create error`, { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * PUT /api/v2/patients/:id - Atualizar (ASYNC)
 */
router.put('/:id', flexibleAuth, async (req, res) => {
  const { id } = req.params;
  const correlationId = `pat_upd_${Date.now()}`;

  try {
    // Resolve o patientId real (pode vir o _id da PatientsView)
    let patientId = id;
    const exists = await Patient.exists({ _id: id });
    if (!exists) {
      const view = await PatientsView.findOne({ $or: [{ _id: id }, { patientId: id }] }).lean();
      if (!view) {
        return res.status(404).json(formatError('Paciente não encontrado', 404));
      }
      patientId = view.patientId;
    }

    const event = await publishEvent(
      EventTypes.PATIENT_UPDATE_REQUESTED,
      {
        patientId,
        updates: req.body,
        updatedBy: req.user?.id,
        updatedAt: new Date().toISOString()
      },
      { correlationId }
    );
    
    return res.status(202).json(
      formatSuccess({
        eventId: event.eventId,
        correlationId,
        jobId: event.jobId,
        status: 'pending',
        checkStatusUrl: `/api/v2/patients/status/${event.eventId}`
      }, { message: 'Atualização em processamento' })
    );
    
  } catch (error) {
    logger.error(`[${correlationId}] Update error`, { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * DELETE /api/v2/patients/:id
 */
router.delete('/:id', flexibleAuth, async (req, res) => {
  const { id } = req.params;
  const correlationId = `pat_del_${Date.now()}`;

  try {
    // Resolve o patientId real (pode vir o _id da PatientsView)
    let patientId = id;
    const exists = await Patient.exists({ _id: id });
    if (!exists) {
      const view = await PatientsView.findOne({ $or: [{ _id: id }, { patientId: id }] }).lean();
      if (!view) {
        return res.status(404).json(formatError('Paciente não encontrado', 404));
      }
      patientId = view.patientId;
    }

    const event = await publishEvent(
      EventTypes.PATIENT_DELETE_REQUESTED,
      {
        patientId,
        reason: req.body?.reason || null,
        deletedBy: req.user?.id,
        deletedAt: new Date().toISOString()
      },
      { correlationId }
    );

    return res.status(202).json(
      formatSuccess({
        eventId: event.eventId,
        correlationId,
        patientId,
        status: 'pending',
        checkStatusUrl: `/api/v2/patients/status/${event.eventId}`
      }, { message: 'Exclusão em processamento' })
    );

  } catch (error) {
    logger.error(`[${correlationId}] Delete error`, { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

// ============================================
// STATUS & MONITORING
// ============================================

/**
 * GET /api/v2/patients/status/:eventId
 */
router.get('/status/:eventId', flexibleAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    
    const { getEventStatus } = await import('../infrastructure/events/eventStoreService.js');
    const status = await getEventStatus(eventId);
    
    if (!status) {
      return res.status(404).json(formatError('Evento não encontrado', 404));
    }
    
    // Se completou, inclui view no nível raiz (frontend lê response.data.data.patientView)
    let patientView = null;
    if (status.status === 'completed' && status.payload?.patientId) {
      patientView = await PatientsView.findOne({
        patientId: status.payload.patientId
      }).lean();
    }

    return res.json(formatSuccess({ ...status, patientView }));
    
  } catch (error) {
    logger.error('Status error', { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * GET /api/v2/patients/health/projection
 * Health check do projection worker
 */
router.get('/health/projection', flexibleAuth, async (req, res) => {
  try {
    const [workerStatus, metrics] = await Promise.all([
      getProjectionWorkerStatus(),
      getProjectionMetrics(3600000) // última hora
    ]);
    
    return res.json(formatSuccess({
      worker: workerStatus,
      metrics
    }));
    
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * POST /api/v2/patients/admin/rebuild-view/:id
 * Admin: força rebuild
 */
router.post('/admin/rebuild-view/:id', flexibleAuth, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json(formatError('Acesso negado', 403));
    }
    
    const { id } = req.params;
    const correlationId = req.headers['x-correlation-id'] || `admin_rebuild_${Date.now()}`;
    
    const view = await buildPatientView(id, { 
      force: true,
      correlationId
    });
    
    if (!view) {
      return res.status(404).json(formatError('Paciente não encontrado', 404));
    }
    
    return res.json(formatSuccess({
      patientId: id,
      viewVersion: view.snapshot.version,
      calculatedAt: view.snapshot.calculatedAt,
      stats: view.stats
    }, 'View reconstruída'));
    
  } catch (error) {
    logger.error('Admin rebuild error', { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

// ============================================
// DEBUG ROUTES (montado em subpath)
// ============================================
router.use('/', patientV2DebugRoutes);

export default router;
