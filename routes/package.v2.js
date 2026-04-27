// back/routes/package.v2.js
/**
 * Package Routes V2 - CQRS Read API + Synchronous Create
 * 
 * Características:
 * - POST: Criação síncrona com agenda completa (novo)
 * - GET: Leitura otimizada via PackagesView (CQRS)
 * - Fallback inteligente (build on miss)
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
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';
import { getHolidaysWithNames } from '../config/feriadosBR-dynamic.js';
import PatientBalance from '../models/PatientBalance.js';
import healthRoutes from './package.v2.health.js';

// 🆕 NOVO: Controller síncrono para criação com agenda
import { createPackageV2, listPackagesV2, getPackageV2, settlePackagePayments } from '../controllers/packageController.v2.js';

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
// Cria novo pacote com agenda completa (SÍNCRONO)
// ============================================

router.post('/', flexibleAuth, createPackageV2);

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
      // Resolver patientId: pode vir como ID da patients_view — buscar o ID real
      let resolvedPatientId = req.query.patientId;
      const patientExists = await mongoose.connection.db.collection('patients').findOne(
        { _id: new mongoose.Types.ObjectId(req.query.patientId) },
        { projection: { _id: 1 } }
      );
      if (!patientExists) {
        const viewDoc = await mongoose.connection.db.collection('patients_view').findOne(
          { _id: new mongoose.Types.ObjectId(req.query.patientId) },
          { projection: { patientId: 1 } }
        );
        if (viewDoc?.patientId) {
          resolvedPatientId = viewDoc.patientId.toString();
        }
      }
      query.patientId = new mongoose.Types.ObjectId(resolvedPatientId);
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
    
    // 2. Verifica se a view precisa ser reconstruída (schema evoluiu)
    const needsRebuild = !packageView || 
                         (packageView.snapshot?.version ?? 0) < 2 ||
                         (packageView.sessions?.length > 0 && !packageView.sessions[0].hasOwnProperty('paymentMethod'));
    
    // 3. FALLBACK: Se não achou ou está desatualizada, builda on-the-fly
    if (!packageView || needsRebuild) {
      logger.info(`[${correlationId}] View not found or stale, building on-the-fly`, { packageId: id, needsRebuild });
      
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
    
    // Resolver patientId: pode vir como ID da patients_view — buscar o ID real
    let resolvedPatientId = patientId;
    const patientExists = await mongoose.connection.db.collection('patients').findOne(
      { _id: new mongoose.Types.ObjectId(patientId) },
      { projection: { _id: 1 } }
    );
    if (!patientExists) {
      const viewDoc = await mongoose.connection.db.collection('patients_view').findOne(
        { _id: new mongoose.Types.ObjectId(patientId) },
        { projection: { patientId: 1 } }
      );
      if (viewDoc?.patientId) {
        resolvedPatientId = viewDoc.patientId.toString();
      }
    }
    
    logger.info(`[${correlationId}] Listing packages for patient ${resolvedPatientId}`);
    
    // Query por paciente
    const query = { patientId: new mongoose.Types.ObjectId(resolvedPatientId) };
    if (options.status) query.status = options.status;
    
    const [packages, total, stats] = await Promise.all([
      PackagesView.find(query)
        .sort({ [options.sortBy]: options.sortOrder })
        .skip(options.skip)
        .limit(options.limit)
        .lean(),
      PackagesView.countDocuments(query),
      PackagesView.getStats(resolvedPatientId)
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

    // 🛡️ Hardening: Executa em sequência para evitar write conflicts
    // e adiciona retry logic para transações
    let retries = 0;
    const maxRetries = 3;
    let lastError;

    while (retries < maxRetries) {
      try {
        // Delete em sequência (não paralelo) para evitar conflitos
        const pkgResult = await Package.findByIdAndDelete(pkgObjectId);
        
        if (!pkgResult) {
          logger.warn('[PackageV2] Package not found for deletion', { correlationId, packageId: id });
        }

        // Só deleta relacionados se o package existia
        if (pkgResult) {
          await Appointment.deleteMany({ package: pkgObjectId });
          await Session.deleteMany({ package: pkgObjectId });
          await Payment.deleteMany({ package: pkgObjectId });
        }

        // Remove a view pelo _id dela
        await PackagesView.findByIdAndDelete(viewId);

        const duration = Date.now() - startTime;

        logger.info('[PackageV2] Package deleted', {
          correlationId,
          packageId: id,
          found: !!pkgResult,
          retry: retries
        });

        return res.status(200).json(formatSuccess({
          packageId: id,
          deleted: !!pkgResult,
          retry: retries
        }, { duration: `${duration}ms`, correlationId }));

      } catch (retryError) {
        lastError = retryError;
        
        // Se for write conflict, faz retry com backoff
        if (retryError.message?.includes('Write conflict') || 
            retryError.message?.includes('transaction')) {
          retries++;
          const delay = Math.pow(2, retries) * 100; // 200ms, 400ms, 800ms
          logger.warn('[PackageV2] Write conflict, retrying...', { 
            correlationId, 
            retry: retries, 
            delay,
            error: retryError.message 
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Outro erro, não faz retry
        throw retryError;
      }
    }

    // Se esgotou retries
    throw lastError || new Error('Max retries exceeded');

  } catch (error) {
    logger.error('[PackageV2] Error deleting package', { 
      correlationId, 
      error: error.message,
      code: error.code 
    });
    
    // Retorna erro específico para write conflict
    if (error.message?.includes('Write conflict')) {
      return res.status(409).json(formatError(
        'WRITE_CONFLICT', 
        'Conflito de escrita detectado. Por favor, tente novamente.', 
        { correlationId, retryable: true }
      ));
    }
    
    res.status(500).json(formatError(
      'INTERNAL_ERROR', 
      'Erro ao deletar pacote', 
      { correlationId, message: error.message }
    ));
  }
});

// ============================================
// POST /api/v2/packages/suggest-slots
// Sugere slots de agenda respeitando débitos como âncora
// ============================================

router.post('/suggest-slots', flexibleAuth, asyncHandler(async (req, res) => {
  const correlationId = `pkg_suggest_${Date.now()}`;
  try {
    const { patientId, specialty, totalSessions = 4, sessionsPerWeek = 1, time = '18:00', selectedDebtIds = [] } = req.body;
    
    if (!patientId || !specialty) {
      return res.status(400).json(formatError('patientId e specialty são obrigatórios', 400));
    }

    // 1. Buscar débitos pendentes do balance
    const balance = await PatientBalance.findOne({ patient: patientId }).lean();
    const debits = (balance?.transactions || [])
      .filter(t => t.type === 'debit' && !t.settledByPackageId && !t.isPaid && t.specialty === specialty)
      .sort((a, b) => new Date(a.transactionDate) - new Date(b.transactionDate));

    // Se selectedDebtIds veio, filtra apenas os selecionados
    const selectedDebits = selectedDebtIds.length > 0
      ? debits.filter(d => selectedDebtIds.includes(d._id.toString()))
      : debits;

    const slots = [];
    let anchorDate = null;
    const yearNow = new Date().getFullYear();
    const holidays = getHolidaysWithNames(yearNow);
    const holidayDates = new Set(holidays.map(h => h.date));

    function addDaysSkippingHolidays(dateStr, days) {
      const d = new Date(dateStr + 'T12:00:00');
      d.setDate(d.getDate() + days);
      let newStr = d.toISOString().split('T')[0];
      // Se cair em feriado, pula para próxima semana (mesmo dia)
      while (holidayDates.has(newStr)) {
        d.setDate(d.getDate() + 7);
        newStr = d.toISOString().split('T')[0];
      }
      return newStr;
    }

    // 2. Se há débitos selecionados, eles viram os primeiros slots
    if (selectedDebits.length > 0) {
      // Buscar appointments para pegar horário real
      const appointmentIds = selectedDebits.map(d => d.appointmentId).filter(Boolean);
      const appointments = appointmentIds.length > 0
        ? await Appointment.find({ _id: { $in: appointmentIds } }).select('date time').lean()
        : [];
      const apptMap = new Map(appointments.map(a => [a._id.toString(), a]));

      for (const debit of selectedDebits) {
        const appt = apptMap.get(debit.appointmentId?.toString());
        const slotDate = appt?.date
          ? new Date(appt.date).toISOString().split('T')[0]
          : new Date(debit.transactionDate).toISOString().split('T')[0];
        const slotTime = appt?.time || time;
        slots.push({ date: slotDate, time: slotTime, source: 'debt', debtId: debit._id.toString() });
      }

      // Último débito define âncora para futuras
      const lastDebt = slots[slots.length - 1];
      anchorDate = lastDebt.date;
    }

    // 3. Gera slots futuros que faltam
    const needed = Math.max(0, totalSessions - slots.length);
    if (needed > 0) {
      const baseDate = anchorDate || new Date().toISOString().split('T')[0];
      let current = baseDate;
      for (let i = 0; i < needed; i++) {
        current = addDaysSkippingHolidays(current, 7);
        slots.push({ date: current, time, source: 'generated' });
      }
    }

    // Remove duplicatas (mesma data+hora)
    const deduped = [];
    const seen = new Set();
    for (const s of slots) {
      const key = `${s.date}|${s.time}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(s);
      }
    }

    // Garante totalSessions (pode aumentar se remoções por dup)
    while (deduped.length < totalSessions && deduped.length > 0) {
      const last = deduped[deduped.length - 1];
      const nextDate = addDaysSkippingHolidays(last.date, 7);
      const key = `${nextDate}|${last.time}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push({ date: nextDate, time: last.time, source: 'generated' });
      } else {
        // evita loop infinito se feriado gerar colisão
        break;
      }
    }

    res.json(formatSuccess({
      slots: deduped.slice(0, totalSessions),
      debtCount: selectedDebits.length,
      generatedCount: Math.max(0, deduped.length - selectedDebits.length),
      anchorDate
    }, {
      message: 'Slots sugeridos com sucesso',
      correlationId
    }));
  } catch (error) {
    logger.error(`[${correlationId}] Error suggesting slots`, { error: error.message });
    res.status(500).json(formatError('Erro ao sugerir slots', 500, { correlationId }));
  }
}));

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

// ============================================================
// 💰 QUITAR DÉBITOS V2 EM PACOTE EXISTENTE
// ============================================================
router.post('/:packageId/settle-payments', flexibleAuth, asyncHandler(async (req, res) => {
  await settlePackagePayments(req, res);
}));

export default router;
