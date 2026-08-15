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
import PatientBalance from '../models/PatientBalance.js';
import { cancelAppointments } from '../domain/appointment/cancelAppointments.js';
import { cancelPendingSessions } from '../domain/session/cancelPendingSessions.js';
import { cancelPendingPayments } from '../domain/payment/cancelPendingPayments.js';
import { runTransactionWithRetry } from '../utils/transactionRetry.js';
import { NON_BLOCKING_OPERATIONAL_STATUSES } from '../constants/appointmentStatus.js';
import { buildDayRange } from '../utils/datetime.js';
import { buildPackageView } from '../domains/billing/services/PackageProjectionService.js';
import { createContextLogger } from '../utils/logger.js';
import updatePackageCommand from '../services/billing/commands/updatePackageCommand.js';
import transferPackageCreditCommand from '../services/billing/commands/transferPackageCreditCommand.js';
import deletePackageCommand from '../services/billing/commands/deletePackageCommand.js';
import { getHolidaysWithNames } from '../config/feriadosBR-dynamic.js';
import healthRoutes from './package.v2.health.js';
import { rebuildPackageFromSource, auditPackage } from '../domain/package/rebuildPackageFromSource.js';

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
    if (options.status) {
      query.status = options.status;
    } else {
      // 🛡️ Por padrão, NÃO listar packages arquivados/superseded
      query.status = { $nin: ['superseded'] };
    }
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
                         (packageView.sessions?.length > 0 && !packageView.sessions[0].hasOwnProperty('paymentMethod')) ||
                         (packageView.sessions?.some(s => s.paymentMethod === undefined || s.paymentMethod === ''));
    
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
// Atualiza pacote via Command + Outbox
// ============================================

router.put('/:id', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  const correlationId = `pkg_update_${Date.now()}`;
  const { id } = req.params;

  try {
    const updateData = req.body;

    // Validação: pacote existe (aceita tanto packageId real quanto _id da view)
    // ⚠️ formatError(code, message, details) — nesta rota a ordem estava invertida,
    // fazendo a resposta trazer {code:"Pacote não encontrado", message:404} e o
    // frontend exibir "500"/"404" no lugar do texto. Corrigido no fluxo de pacote;
    // as demais rotas v2 ainda precisam da padronização (com testes de contrato).
    const existing = await PackagesView.findOne({ $or: [{ packageId: id }, { _id: id }] });
    if (!existing) {
      return res.status(404).json(formatError('PACKAGE_NOT_FOUND', 'Pacote não encontrado', { correlationId }));
    }
    const realPackageId = existing.packageId?.toString() || id;

    logger.info('[PackageV2] Updating package', { correlationId, packageId: realPackageId });

    const result = await updatePackageCommand.execute(
      realPackageId,
      updateData,
      req.user,
      correlationId
    );

    const duration = Date.now() - startTime;

    res.status(200).json(formatSuccess({
      message: result.message,
      packageId: realPackageId,
      data: result.data,
      // `changed:false` = nada foi gravado. O cliente precisa saber para não
      // exibir "atualizado com sucesso" sobre uma alteração que não ocorreu.
      changed: result.changed !== false,
      changedFields: result.changedFields || [],
      ignoredFields: result.ignoredFields || [],
      eventEmitted: result.eventEmitted,
      correlationId: result.correlationId,
    }, {
      duration: `${duration}ms`
    }));

  } catch (error) {
    const status = error.status || 500;

    // 4xx é decisão de negócio esperada, não incidente: não polui o log de erro.
    const logPayload = { correlationId, status, code: error.code, error: error.message };
    if (status >= 500) logger.error('[PackageV2] Error updating package', logPayload);
    else logger.info('[PackageV2] Update rejected by policy', logPayload);

    res.status(status).json(formatError(
      error.code || 'INTERNAL_SERVER_ERROR',
      error.message || 'Erro ao atualizar pacote',
      { correlationId, ...(error.fields ? { fields: error.fields } : {}) }
    ));
  }
});

// ============================================
// POST /api/v2/packages/:id/transfer[/preview]
// Converte sessões não realizadas para outro pacote, levando a cobertura
// já paga. NÃO cria Payment e NÃO gera entrada de caixa — o dinheiro entrou
// no pacote de origem, na data original. Ver transferPackageCreditCommand.js.
// ============================================

router.post('/:id/transfer/preview', flexibleAuth, async (req, res) => {
  const correlationId = `pkg_transfer_preview_${Date.now()}`;
  try {
    const view = await PackagesView.findOne({ $or: [{ packageId: req.params.id }, { _id: req.params.id }] }).lean();
    const realPackageId = view?.packageId?.toString() || req.params.id;

    const data = await transferPackageCreditCommand.preview({
      ...req.body,
      sourcePackageId: realPackageId,
    });

    res.json(formatSuccess(data, { correlationId }));
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) logger.error('[PackageV2] Erro no preview de transferência', { correlationId, error: error.message });
    res.status(status).json(formatError(
      error.code || 'INTERNAL_SERVER_ERROR',
      error.message || 'Erro ao simular transferência',
      { correlationId }
    ));
  }
});

router.post('/:id/transfer', flexibleAuth, async (req, res) => {
  const correlationId = `pkg_transfer_${Date.now()}`;
  try {
    const view = await PackagesView.findOne({ $or: [{ packageId: req.params.id }, { _id: req.params.id }] }).lean();
    const realPackageId = view?.packageId?.toString() || req.params.id;

    const result = await transferPackageCreditCommand.execute(
      { ...req.body, sourcePackageId: realPackageId },
      req.user,
      correlationId
    );

    // ⚠️ createContextLogger é (event, message, meta). Chamar com 2 argumentos
    // — como o resto deste arquivo faz — imprime "[object Object] {}" e some
    // com o motivo do erro. Foi exatamente o que escondeu o ValidationError de
    // paymentMethod no primeiro teste em produção.
    logger.info('transfer_completed', `Transferência concluída: ${result.data?.sessionCount} sessão(ões), R$ ${result.data?.amount}, caixa 0`, {
      correlationId,
      sourcePackageId: realPackageId,
      targetPackageId: result.targetPackage?._id?.toString(),
      alreadyProcessed: Boolean(result.alreadyProcessed),
    });

    res.status(result.alreadyProcessed ? 200 : 201).json(formatSuccess({
      transfer: result.data,
      targetPackage: result.targetPackage || null,
      canceledNow: result.canceledNow ?? 0,
      restamped: result.restamped ?? 0,
      alreadyProcessed: Boolean(result.alreadyProcessed),
      message: result.message,
    }, { correlationId }));
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      logger.error('transfer_failed', error.message || 'erro desconhecido', {
        correlationId,
        code: error.code,
        name: error.name,
        // ValidationError do Mongoose traz o campo culpado em `errors`
        fields: error.errors ? Object.keys(error.errors) : undefined,
        validation: error.errors
          ? Object.values(error.errors).map(e => `${e.path}: ${e.message}`)
          : undefined,
        stack: error.stack?.split('\n').slice(0, 4).join(' | '),
      });
    } else {
      logger.info('transfer_rejected', error.message, { correlationId, code: error.code });
    }

    res.status(status).json(formatError(
      error.code || 'INTERNAL_SERVER_ERROR',
      error.message || 'Erro ao transferir sessões',
      { correlationId, ...(error.appointmentId ? { appointmentId: error.appointmentId } : {}) }
    ));
  }
});

// ============================================
// POST /api/v2/packages/:id/inactivate
// Inativa pacote: cancela pendências, mantém histórico
// ============================================
router.post('/:id/inactivate', flexibleAuth, async (req, res) => {
  const correlationId = `pkg_inactivate_${Date.now()}`;
  const { id } = req.params;

  try {
    const view = await PackagesView.findById(new mongoose.Types.ObjectId(id)).lean();
    if (!view) return res.status(404).json(formatError('Pacote não encontrado'));

    const realPackageId = view.packageId || id;
    const pkgObjectId = new mongoose.Types.ObjectId(realPackageId);

    const pkg = await Package.findById(pkgObjectId).lean();
    if (!pkg) return res.status(404).json(formatError('Pacote não encontrado'));
    const inactiveStatuses = ['canceled', 'cancelled']; // 'cancelled' mantido até a migration rodar em todo o histórico
    if (inactiveStatuses.includes(pkg.status)) {
      return res.status(400).json(formatError('Pacote já está inativo'));
    }

    if (pkg.paymentType !== 'per-session') {
      return res.status(409).json(formatError(
        'PACKAGE_INACTIVATION_REQUIRES_PER_SESSION',
        'Somente pacotes com pagamento por sessao podem ser inativados por este fluxo.'
      ));
    }

    const pendingStatuses = ['scheduled', 'pending', 'unpaid', 'booked'];

    // 🛡️ PATCH OPERACIONAL (2026-08-15): a cascata inteira (Session + Appointment +
    // Payment + status do Package) agora roda dentro de UMA transação. Antes eram
    // 3 updateMany em paralelo + 1 update do Package depois, nenhum com ClientSession
    // — uma falha no meio podia deixar sessões/appointments cancelados com o Package
    // ainda 'active'. O guard de "já está inativo" é reconferido DENTRO da transação
    // (não só antes) para cobrir o caso de duas chamadas concorrentes: a que perder a
    // corrida aborta sem mutar nada — idempotente mesmo sob concorrência real.
    const { sessionsCanceled, appointmentsCanceled, paymentsCanceled } = await runTransactionWithRetry(async (mongoSession) => {
      const freshPkg = await Package.findById(pkgObjectId).session(mongoSession);
      if (!freshPkg) {
        const err = new Error('Pacote não encontrado');
        err.status = 404;
        throw err;
      }
      if (inactiveStatuses.includes(freshPkg.status)) {
        const err = new Error('Pacote já está inativo');
        err.status = 400;
        err.code = 'PACKAGE_ALREADY_INACTIVE';
        throw err;
      }

      // Sessões em aberto (não completadas e não canceladas)
      if (freshPkg.paymentType !== 'per-session') {
        const err = new Error('Somente pacotes com pagamento por sessao podem ser inativados por este fluxo.');
        err.status = 409;
        err.code = 'PACKAGE_INACTIVATION_REQUIRES_PER_SESSION';
        throw err;
      }

      const pendingSessions = await Session.find({
        package: pkgObjectId,
        status: { $in: pendingStatuses }
      }).session(mongoSession).lean();
      const pendingSessionIds = pendingSessions.map(s => s._id);

      // Appointments vinculados a essas sessões
      const appointmentIds = pendingSessions
        .map(s => s.appointmentId)
        .filter(Boolean);

      const sessionsResult = await cancelPendingSessions({ _id: { $in: pendingSessionIds } }, mongoSession);
      const appointmentsResult = appointmentIds.length > 0
        ? await cancelAppointments({
            _id: { $in: appointmentIds },
            operationalStatus: { $nin: ['completed', 'canceled', 'cancelled'] }
          }, mongoSession)
        : { modifiedCount: 0 };
      const paymentsResult = await cancelPendingPayments(
        { package: pkgObjectId, status: { $in: ['pending', 'scheduled'] } },
        mongoSession
      );

      // Só muda o status do Package DEPOIS da cascata, dentro da mesma transação.
      await Package.findByIdAndUpdate(
        pkgObjectId,
        { status: 'canceled', updatedAt: new Date() },
        { session: mongoSession, runValidators: true }
      );

      return {
        sessionsCanceled: sessionsResult.modifiedCount,
        appointmentsCanceled: appointmentsResult.modifiedCount,
        paymentsCanceled: paymentsResult.modifiedCount,
      };
    });

    // Reconstrói a view — read-model derivado, fora da transação de propósito:
    // se falhar aqui, o cancelamento real já está commitado e correto, só a
    // projeção fica temporariamente desatualizada (mesmo padrão do resto do arquivo).
    await buildPackageView(realPackageId.toString(), { correlationId, force: true });

    logger.info('[PackageV2] Package inactivated', {
      correlationId,
      packageId: id,
      sessionsCanceled,
      appointmentsCanceled,
      paymentsCanceled
    });

    return res.json(formatSuccess({
      packageId: id,
      sessionsCanceled,
      appointmentsCanceled,
      paymentsCanceled
    }));

  } catch (err) {
    logger.error('[PackageV2] Error inactivating package', { correlationId, error: err.message });
    const status = err.status || 500;
    return res.status(status).json(formatError(err.code || 'PACKAGE_INACTIVATION_FAILED', err.message));
  }
});

// ============================================
// DELETE /api/v2/packages/:id
// ============================================
// PATCH /api/v2/packages/:id/appointments/bulk
// Bulk-atualiza terapeuta e/ou horário de todos os
// appointments pre_agendado/scheduled do pacote.
// Confirmed/completed NÃO são alterados.
// Body: { doctorId?, time? } — ao menos um obrigatório.
// ============================================

router.patch('/:id/appointments/bulk', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { doctorId, time, dayOfWeek } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'ID inválido' });
  }
  if (!doctorId && !time && dayOfWeek === undefined) {
    return res.status(400).json({ success: false, message: 'Informe doctorId, time e/ou dayOfWeek' });
  }
  if (doctorId && !mongoose.Types.ObjectId.isValid(doctorId)) {
    return res.status(400).json({ success: false, message: 'doctorId inválido' });
  }
  if (time && !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ success: false, message: 'time deve estar no formato HH:MM' });
  }
  if (dayOfWeek !== undefined && (dayOfWeek < 0 || dayOfWeek > 6)) {
    return res.status(400).json({ success: false, message: 'dayOfWeek deve ser 0 (dom) a 6 (sab)' });
  }

  // Resolve o packageId real (pode vir como PackagesView._id)
  const viewId = new mongoose.Types.ObjectId(id);
  const view = await PackagesView.findById(viewId).lean();
  const realPackageId = view?.packageId ? new mongoose.Types.ObjectId(view.packageId) : viewId;

  const pendingStatuses = ['pre_agendado', 'scheduled'];

  // 🚨 FIX (2026-07-20): este endpoint só escrevia em Appointment — a Session vinculada
  // (mesmo appointmentId) nunca era tocada. Mesmo padrão já corrigido em
  // insuranceGuides.v2.js (PATCH /:id/appointments/doctor), insurancePlans.v2.js e
  // liminarContractController.js: doctor/time/date ficavam corretos no Appointment e
  // travados no valor antigo na Session, e o conflictDetection.js lê Session.doctor/time
  // pra checar ocupação — causava falso conflito de agenda com o profissional/horário
  // ERRADO pra pacotes particular/therapy.
  //
  // 🛡️ PATCH OPERACIONAL (2026-08-15): antes escrevia direto, appointment por
  // appointment, sem checar conflito e sem transação — um lote de 8 sessões podia
  // ficar com 5 movidas e 3 no ar se a 6ª estourasse erro, e podia sobrepor a
  // agenda de outro paciente/profissional silenciosamente. Agora: (1) calcula
  // TODOS os destinos antes de escrever qualquer coisa; (2) valida colisão interna
  // do próprio lote; (3) valida conflito de médico e paciente contra o resto do
  // sistema; (4) só então aplica tudo dentro de uma única transação. completed/
  // confirmed continuam de fora — pendingStatuses não muda.

  const doctorObjectId = doctorId ? new mongoose.Types.ObjectId(doctorId) : null;

  const appointments = await Appointment.find(
    { package: realPackageId, operationalStatus: { $in: pendingStatuses } }
  ).select('_id date time doctor patient').lean();

  if (appointments.length === 0) {
    return res.json({ success: true, data: { updated: 0, sessionsUpdated: 0, paymentsUpdated: 0 } });
  }

  // 1️⃣ Pré-calcula todos os destinos (data/hora/médico) — nenhuma escrita ainda.
  const targets = appointments.map((appt) => {
    let newDateStr = new Date(appt.date).toISOString().substring(0, 10);
    if (dayOfWeek !== undefined) {
      const current = new Date(appt.date);
      const currentDay = current.getDay(); // 0=dom … 6=sab
      let diff = dayOfWeek - currentDay;
      if (diff <= 0) diff += 7; // próxima ocorrência futura do dia
      const newDate = new Date(current);
      newDate.setDate(newDate.getDate() + diff);
      newDateStr = newDate.toISOString().substring(0, 10);
    }
    return {
      appointmentId: appt._id,
      patientId: appt.patient,
      date: newDateStr,
      time: time || appt.time,
      doctorId: doctorObjectId || appt.doctor,
    };
  });

  const batchAppointmentIds = targets.map((t) => t.appointmentId);

  // 2️⃣ Colisão interna do próprio lote: duas sessões deste pacote acabando no
  // mesmo médico+data+hora (pode acontecer com dayOfWeek — vários appointments
  // originalmente em semanas diferentes podem convergir pro mesmo dia).
  const seenSlots = new Map();
  const internalCollisions = [];
  for (const target of targets) {
    const key = `${target.doctorId}_${target.date}_${target.time}`;
    if (seenSlots.has(key)) {
      internalCollisions.push({
        appointmentId: target.appointmentId.toString(),
        collidesWithAppointmentId: seenSlots.get(key).toString(),
        date: target.date,
        time: target.time,
      });
    } else {
      seenSlots.set(key, target.appointmentId);
    }
  }
  if (internalCollisions.length > 0) {
    return res.status(409).json({
      success: false,
      code: 'BULK_INTERNAL_COLLISION',
      message: 'A alteração em massa colocaria duas sessões deste pacote no mesmo horário com o mesmo profissional.',
      conflicts: internalCollisions,
    });
  }

  // 3️⃣ Conflito de médico e paciente contra o resto do sistema (fora deste lote).
  const externalConflicts = [];
  for (const target of targets) {
    const dayRange = buildDayRange(target.date);
    const [doctorConflict, patientConflict] = await Promise.all([
      Appointment.findOne({
        doctor: target.doctorId,
        date: dayRange,
        time: target.time,
        operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
        _id: { $nin: batchAppointmentIds },
      }).select('_id patient').lean(),
      target.patientId
        ? Appointment.findOne({
            patient: target.patientId,
            date: dayRange,
            time: target.time,
            operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
            _id: { $nin: batchAppointmentIds },
          }).select('_id doctor').lean()
        : null,
    ]);
    if (doctorConflict) {
      externalConflicts.push({
        appointmentId: target.appointmentId.toString(),
        type: 'doctor',
        conflictingAppointmentId: doctorConflict._id.toString(),
        date: target.date,
        time: target.time,
      });
    }
    if (patientConflict) {
      externalConflicts.push({
        appointmentId: target.appointmentId.toString(),
        type: 'patient',
        conflictingAppointmentId: patientConflict._id.toString(),
        date: target.date,
        time: target.time,
      });
    }
  }
  if (externalConflicts.length > 0) {
    return res.status(409).json({
      success: false,
      code: 'BULK_SCHEDULE_CONFLICT',
      message: 'Um ou mais horários da alteração em massa conflitam com agendamentos existentes.',
      conflicts: externalConflicts,
    });
  }

  // 4️⃣ Zero conflito — aplica tudo (Appointment + Session + Payment) numa única transação.
  const { updated, sessionsUpdated, paymentsUpdated } = await runTransactionWithRetry(async (mongoSession) => {
    let updatedCount = 0;
    let sessionsUpdatedCount = 0;
    let paymentsUpdatedCount = 0;

    for (const target of targets) {
      const setFields = { date: target.date, time: target.time, doctor: target.doctorId };

      const r = await Appointment.updateOne(
        { _id: target.appointmentId },
        { $set: setFields },
        { session: mongoSession }
      );
      updatedCount += r.modifiedCount;

      const sr = await Session.updateOne(
        { appointmentId: target.appointmentId, status: { $nin: ['completed', 'canceled'] } },
        { $set: { ...setFields, updatedAt: new Date() } },
        { session: mongoSession }
      );
      sessionsUpdatedCount += sr.modifiedCount;

      // Mesmo escopo reduzido de antes: só doctor (nunca time/date, que têm
      // semântica financeira própria) e só em payments ainda pending.
      if (doctorObjectId) {
        const pr = await Payment.updateOne(
          { appointment: target.appointmentId, status: { $nin: ['paid', 'canceled'] } },
          { $set: { doctor: doctorObjectId, updatedAt: new Date() } },
          { session: mongoSession }
        );
        paymentsUpdatedCount += pr.modifiedCount;
      }
    }

    return { updated: updatedCount, sessionsUpdated: sessionsUpdatedCount, paymentsUpdated: paymentsUpdatedCount };
  });

  return res.json({ success: true, data: { updated, sessionsUpdated, paymentsUpdated } });
}));

// ============================================
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
      const mongoSession = await mongoose.startSession();
      try {
        await mongoSession.startTransaction();

        // Busca o pacote ANTES de deletar (para ajustar PatientBalance)
        const pkgResult = await Package.findById(pkgObjectId).session(mongoSession);

        if (!pkgResult) {
          logger.warn('[PackageV2] Package not found for deletion', { correlationId, packageId: id });
        }

        if (pkgResult) {
          // Coleta IDs de relacionados para ajuste do PatientBalance
          const appointmentIds = (await Appointment.find({ package: pkgObjectId })
            .select('_id')
            .session(mongoSession)
            .lean()).map(a => a._id.toString());
          const sessionIds = (await Session.find({ package: pkgObjectId })
            .select('_id')
            .session(mongoSession)
            .lean()).map(s => s._id.toString());

          // 🏦 REVERTE transações do PatientBalance associadas ao pacote
          const patientBalance = await PatientBalance.findOne({ patient: pkgResult.patient }).session(mongoSession);
          if (patientBalance) {
            const packageIdStr = pkgObjectId.toString();
            let balanceChanged = false;

            for (const tx of patientBalance.transactions) {
              const txPackageId = tx.settledByPackageId?.toString?.();
              const txAppointmentId = tx.appointmentId?.toString?.();
              const txSessionId = tx.sessionId?.toString?.();

              const belongsToPackage = txPackageId === packageIdStr;
              const belongsToRelated = appointmentIds.includes(txAppointmentId) || sessionIds.includes(txSessionId);

              if (!belongsToPackage && !belongsToRelated) continue;
              if (tx.isDeleted) continue;

              if (tx.type === 'credit') {
                // Reverte crédito: aumenta o saldo devedor
                patientBalance.currentBalance += tx.amount;
                patientBalance.totalCredited = Math.max(0, (patientBalance.totalCredited || 0) - tx.amount);
                tx.isDeleted = true;
                tx.deletedAt = new Date();
                tx.deleteReason = `Pacote ${packageIdStr} deletado`;
                balanceChanged = true;
              } else if (tx.type === 'debit' && tx.isPaid) {
                // Reabre débito quitado pelo pacote
                tx.isPaid = false;
                tx.paidAmount = 0;
                tx.settledByPackageId = null;
                patientBalance.currentBalance += tx.amount;
                balanceChanged = true;
              } else if (tx.type === 'debit' && !tx.isPaid) {
                // Débito não quitado associado ao pacote é removido (soft delete)
                tx.isDeleted = true;
                tx.deletedAt = new Date();
                tx.deleteReason = `Pacote ${packageIdStr} deletado`;
                patientBalance.currentBalance = Math.max(0, patientBalance.currentBalance - tx.amount);
                patientBalance.totalDebited = Math.max(0, (patientBalance.totalDebited || 0) - tx.amount);
                balanceChanged = true;
              }
            }

            if (balanceChanged) {
              patientBalance.lastTransactionAt = new Date();
              await patientBalance.save({ session: mongoSession });
              logger.info('[PackageV2] PatientBalance ajustado após deleção de pacote', {
                correlationId,
                packageId: id,
                patientId: pkgResult.patient.toString(),
                newBalance: patientBalance.currentBalance
              });
            }
          }

          // Deleta relacionados
          await Appointment.deleteMany({ package: pkgObjectId }).session(mongoSession);
          await Session.deleteMany({ package: pkgObjectId }).session(mongoSession);
          await Payment.deleteMany({ package: pkgObjectId }).session(mongoSession);
          await Package.deleteOne({ _id: pkgObjectId }).session(mongoSession);
        }

        // Remove a view pelo _id dela
        await PackagesView.findByIdAndDelete(viewId).session(mongoSession);

        await mongoSession.commitTransaction();

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
        await mongoSession.abortTransaction();
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
      } finally {
        await mongoSession.endSession();
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
