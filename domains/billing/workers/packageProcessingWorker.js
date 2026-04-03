// back/domains/billing/workers/packageProcessingWorker.js
/**
 * Package Processing Worker
 *
 * Responsabilidade: Processar criação de pacotes V2
 *
 * Princípios:
 * - Lógica isolada (não chama V1)
 * - Idempotência via requestId
 * - Sempre emite evento de resultado
 */

import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { redisConnection } from '../../../infrastructure/queue/queueConfig.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../../../utils/logger.js';
import Package from '../../../models/Package.js';
import Session from '../../../models/Session.js';
import Payment from '../../../models/Payment.js';
import Appointment from '../../../models/Appointment.js';
import Patient from '../../../models/Patient.js';
import { distributePayments } from '../../../services/distributePayments.js';
import { syncEvent } from '../../../services/syncService.js';

const logger = createContextLogger('PackageProcessingWorker');

// Cache de requestIds processados (idempotência)
const processedRequests = new Map();
const REQUEST_CACHE_TTL = 60 * 60 * 1000; // 1 hora

// Limpa cache antigo
setInterval(() => {
  const now = Date.now();
  for (const [requestId, timestamp] of processedRequests) {
    if (now - timestamp > REQUEST_CACHE_TTL) {
      processedRequests.delete(requestId);
    }
  }
}, 10 * 60 * 1000);

// ============================================
// HOLIDAY ADJUSTMENT (simplified fallback)
// ============================================
function adjustDateIfHoliday(dateStr, timeStr) {
  // Fallback simplificado: utils/holidays.js não existe no projeto
  return dateStr;
}

// ============================================
// WORKER
// ============================================

export const packageProcessingWorker = new Worker(
  'package-processing',
  async (job) => {
    const { eventType, payload, correlationId, requestId } = job.data;
    const startTime = Date.now();

    logger.info('[PackageProcessingWorker] Processing job', {
      correlationId,
      eventType,
      requestId,
      jobId: job.id,
      attempt: job.attemptsMade + 1
    });

    // IDEMPOTÊNCIA: Já processou?
    if (requestId && processedRequests.has(requestId)) {
      logger.info('[PackageProcessingWorker] Request already processed', {
        correlationId,
        requestId
      });
      return { status: 'already_processed', requestId };
    }

    try {
      let result;

      switch (eventType) {
        case 'PACKAGE_CREATE_REQUESTED':
          result = await handlePackageCreate(payload, correlationId);
          break;

        default:
          logger.warn('[PackageProcessingWorker] Unknown event type', {
            correlationId,
            eventType
          });
          return { status: 'ignored', reason: 'unknown_event' };
      }

      // Registra como processado
      if (requestId) {
        processedRequests.set(requestId, Date.now());
      }

      const duration = Date.now() - startTime;
      logger.info('[PackageProcessingWorker] Job completed', {
        correlationId,
        eventType,
        durationMs: duration,
        result: result.operation
      });

      return {
        success: true,
        eventType,
        duration: `${duration}ms`,
        ...result
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('[PackageProcessingWorker] Job failed', {
        correlationId,
        eventType,
        error: error.message,
        durationMs: duration,
        willRetry: job.attemptsMade < 5
      });

      // Emite evento de falha
      await publishEvent('PACKAGE_CREATE_FAILED', {
        requestId,
        correlationId,
        error: error.message,
        errorType: error.name,
        payload
      }, { correlationId });

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 3,
    limiter: { max: 10, duration: 1000 },
    stalledInterval: 30000,
    lockDuration: 30000
  }
);

// ============================================
// HANDLERS
// ============================================

export async function handlePackageCreate(payload, correlationId) {
  const mongoSession = await mongoose.startSession();
  let transactionCommitted = false;

  try {
    await mongoSession.startTransaction();

    let {
      date,
      patientId,
      doctorId,
      specialty,
      paymentMethod,
      paymentType,
      durationMonths,
      sessionsPerWeek,
      sessionType,
      appointmentId,
      sessionValue,
      calculationMode,
      totalSessions,
      selectedSlots = [],
      payments = [],
      type = 'therapy',
      liminarProcessNumber,
      liminarCourt,
      liminarExpirationDate,
      liminarMode = 'hybrid',
      liminarAuthorized = true,
      requestId
    } = payload;

    // Deriva data do primeiro slot se não informada
    if (!date && selectedSlots.length > 0) {
      date = selectedSlots[0].date;
    }

    // ==========================================================
    // 1️⃣ VALIDAÇÕES BÁSICAS
    // ==========================================================
    if (date === 'Invalid date' || !moment(date, 'YYYY-MM-DD', true).isValid()) {
      throw new Error('Data inválida');
    }

    if (!date || !patientId || !doctorId || !sessionType || !specialty || sessionValue === undefined || sessionValue === null) {
      throw new Error('Campos obrigatórios não fornecidos');
    }

    if (!selectedSlots.length) {
      throw new Error('Nenhum horário selecionado (selectedSlots está vazio)');
    }

    // ⚖️ Log para pacotes liminar
    if (type === 'liminar') {
      logger.info('⚖️ Criando pacote LIMINAR', {
        processo: liminarProcessNumber || 'Não informado',
        vara: liminarCourt || 'Não informada',
        modo: liminarMode
      });
    }

    // Verifica idempotência no banco (dupla proteção)
    const existingPackage = await Package.findOne({
      'metadata.requestId': requestId
    }).session(mongoSession);

    if (existingPackage) {
      logger.info('[PackageProcessingWorker] Package already exists', {
        correlationId,
        requestId,
        packageId: existingPackage._id
      });

      await mongoSession.abortTransaction();

      return {
        operation: 'package_already_exists',
        packageId: existingPackage._id,
        requestId
      };
    }

    // ==========================================================
    // 2️⃣ CONVERSÃO / REAPROVEITAMENTO DO PRIMEIRO SLOT EXISTENTE
    // ==========================================================
    let existingAppointment = null;
    let replacedAppointmentId = null;
    let replacedSessionId = null;

    // 2.1) Caso explícito: veio appointmentId no body
    if (appointmentId) {
      existingAppointment = await Appointment.findById(appointmentId)
        .populate('session')
        .lean();

      if (!existingAppointment) {
        throw new Error('Agendamento a ser convertido não encontrado');
      }

      if (existingAppointment.package || existingAppointment.session?.package) {
        const err = new Error('Este agendamento já está vinculado a um pacote e não pode ser usado para criar outro.');
        err.code = 'APPOINTMENT_IN_OTHER_PACKAGE';
        err.packageId = existingAppointment.package || existingAppointment.session?.package;
        throw err;
      }

      const sessionIdToDelete = existingAppointment.session?._id;
      replacedSessionId = sessionIdToDelete?.toString();
      replacedAppointmentId = appointmentId;

      await Appointment.deleteOne({ _id: appointmentId }).session(mongoSession);
      if (sessionIdToDelete) {
        await Session.deleteOne({ _id: sessionIdToDelete }).session(mongoSession);
      }
    }

    // 2.2) Caso implícito: detectar pelo primeiro slot
    if (!existingAppointment && selectedSlots?.length > 0) {
      const firstSlot = selectedSlots[0];
      if (firstSlot?.date && firstSlot?.time) {
        const toConvert = await Appointment.findOne({
          patient: patientId,
          doctor: doctorId,
          date: firstSlot.date,
          time: firstSlot.time,
          status: { $ne: 'canceled' }
        })
          .populate('session')
          .lean();

        if (toConvert) {
          if (toConvert.package || toConvert.session?.package) {
            const err = new Error('Este agendamento já está vinculado a um pacote e não pode ser usado para criar outro.');
            err.code = 'APPOINTMENT_IN_OTHER_PACKAGE';
            err.packageId = toConvert.package || toConvert.session?.package;
            throw err;
          }

          const sessionIdToDelete = toConvert.session?._id;
          replacedSessionId = sessionIdToDelete?.toString();
          replacedAppointmentId = toConvert._id.toString();

          await Appointment.deleteOne({ _id: toConvert._id }).session(mongoSession);
          if (sessionIdToDelete) {
            await Session.deleteOne({ _id: sessionIdToDelete }).session(mongoSession);
          }
        }
      }
    }

    // ==========================================================
    // 3️⃣ CÁLCULO DE SESSÕES E VALORES
    // ==========================================================
    const numericSessionValue = Number(sessionValue) || 0;
    const numericSessionsPerWeek = Number(sessionsPerWeek) || selectedSlots.length;
    const numericDurationMonths = Number(durationMonths) || 0;
    const numericTotalSessions = Number(totalSessions) || 0;

    let finalTotalSessions, finalDurationMonths;
    if (calculationMode === 'sessions') {
      finalTotalSessions = numericTotalSessions;
      finalDurationMonths = Math.ceil(finalTotalSessions / ((numericSessionsPerWeek * 4) || 1));
    } else {
      finalTotalSessions = numericDurationMonths * 4 * numericSessionsPerWeek;
      finalDurationMonths = numericDurationMonths;
    }

    const totalValue = numericSessionValue * finalTotalSessions;

    // ==========================================================
    // 4️⃣ CRIAR O PACOTE
    // ==========================================================
    const packageData = {
      patient: patientId,
      doctor: doctorId,
      date,
      sessionType,
      specialty,
      sessionValue: numericSessionValue,
      totalSessions: finalTotalSessions,
      sessionsPerWeek: numericSessionsPerWeek,
      durationMonths: finalDurationMonths,
      paymentMethod,
      paymentType,
      totalValue,
      totalPaid: 0,
      balance: totalValue,
      status: 'active',
      calculationMode,
      type,
      metadata: {
        requestId,
        correlationId,
        createdAt: new Date()
      }
    };

    if (type === 'liminar') {
      packageData.liminarProcessNumber = liminarProcessNumber;
      packageData.liminarCourt = liminarCourt;
      packageData.liminarExpirationDate = liminarExpirationDate || null;
      packageData.liminarMode = liminarMode;
      packageData.liminarAuthorized = liminarAuthorized;
      packageData.liminarTotalCredit = totalValue;
      packageData.liminarCreditBalance = totalValue;
      packageData.recognizedRevenue = 0;
      packageData.financialStatus = 'unpaid';
    }

    const newPackage = new Package(packageData);
    await newPackage.save({ session: mongoSession });

    // 🔧 Reconciliação de pagamentos herdados da sessão/appointment avulso
    if (replacedSessionId) {
      await Payment.deleteMany(
        {
          session: replacedSessionId,
          status: { $in: ['pending', 'unpaid'] },
          serviceType: { $in: ['individual_session', 'evaluation'] }
        },
        { session: mongoSession }
      );

      await Payment.updateMany(
        {
          session: replacedSessionId,
          status: 'paid',
          serviceType: { $in: ['individual_session', 'evaluation'] }
        },
        {
          $set: {
            package: newPackage._id,
            kind: 'package_receipt',
            serviceType: 'package_session',
            migratedFrom: { session: replacedSessionId }
          },
          $unset: { session: '', appointment: '' }
        },
        { session: mongoSession }
      );
    }

    if (replacedAppointmentId) {
      await Payment.updateMany(
        {
          appointment: replacedAppointmentId,
          status: { $in: ['pending', 'unpaid'] },
          serviceType: { $in: ['individual_session', 'evaluation'] }
        },
        { $unset: { appointment: '' } },
        { session: mongoSession }
      );

      await Payment.updateMany(
        {
          appointment: replacedAppointmentId,
          status: 'paid',
          serviceType: { $in: ['individual_session', 'evaluation'] }
        },
        {
          $set: {
            package: newPackage._id,
            kind: 'package_receipt',
            serviceType: 'package_session',
            migratedFrom: { appointment: replacedAppointmentId }
          },
          $unset: { appointment: '' }
        },
        { session: mongoSession }
      );
    }

    await Patient.findByIdAndUpdate(
      patientId,
      { $addToSet: { packages: newPackage._id } },
      { session: mongoSession }
    );

    // ==========================================================
    // 5️⃣ GERAR SESSÕES E AGENDAMENTOS
    // ==========================================================
    const sessionsToCreate = [];

    for (const slot of selectedSlots) {
      if (!slot.date || !slot.time) continue;

      const adjustedDate = adjustDateIfHoliday(slot.date, slot.time);

      sessionsToCreate.push({
        date: adjustedDate,
        time: slot.time,
        patient: patientId,
        doctor: doctorId,
        package: newPackage._id,
        sessionValue: numericSessionValue,
        sessionType,
        specialty,
        status: 'scheduled',
        isPaid: false,
        paymentStatus: 'pending',
        visualFlag: 'pending',
        paymentMethod
      });
    }

    const insertedSessions = await Session.insertMany(sessionsToCreate, { session: mongoSession });

    // 🔥 CALCULA SE É PRIMEIRO AGENDAMENTO DO PACIENTE
    const existingAppointments = await Appointment.countDocuments({
      patient: patientId
    }).session(mongoSession);
    const isFirstAppointment = existingAppointments === 0;

    const appointmentsToCreate = [];
    for (const s of insertedSessions) {
      appointmentsToCreate.push({
        patient: patientId,
        doctor: doctorId,
        date: s.date,
        time: s.time,
        duration: 40,
        specialty,
        session: s._id,
        package: newPackage._id,
        serviceType: 'package_session',
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        paymentStatus: 'pending',
        sessionValue: numericSessionValue,
        isFirstAppointment
      });
    }

    const seen = new Set();
    const uniqueAppointments = [];
    for (const a of appointmentsToCreate) {
      const key = `${a.date}-${a.time}-${a.patient}-${a.doctor}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueAppointments.push(a);
      } else {
        logger.warn(`⛔ Sessão duplicada ignorada: ${key}`);
      }
    }

    const insertedAppointments = await Appointment.insertMany(uniqueAppointments, { session: mongoSession });

    // 🔗 Vincula sessions e appointments com base em data/hora
    const appointmentMap = new Map(
      insertedAppointments.map(a => [`${a.date}-${a.time}-${a.patient}-${a.doctor}`, a._id])
    );

    await Session.bulkWrite(
      insertedSessions.map(s => {
        const key = `${s.date}-${s.time}-${s.patient}-${s.doctor}`;
        const appId = appointmentMap.get(key);

        if (!appId) {
          logger.warn(`⚠️ Sessão sem appointment correspondente (${key}) — será ignorada no link.`);
          return { updateOne: { filter: { _id: s._id }, update: {} } };
        }

        return {
          updateOne: {
            filter: { _id: s._id },
            update: { $set: { appointmentId: appId } }
          }
        };
      }),
      { session: mongoSession }
    );

    // ==========================================================
    // 6️⃣ PAGAMENTOS
    // ==========================================================
    let amountPaid = 0;
    const paymentDocs = [];

    if (paymentType === 'per-session') {
      logger.info(`[CREATE PACKAGE] Modo per-session: ignorando ${payments.length} pagamentos do body`);
    } else {
      for (const p of payments) {
        const value = Number(p.amount) || 0;
        if (value <= 0) continue;

        const paymentDoc = new Payment({
          package: newPackage._id,
          patient: patientId,
          doctor: doctorId,
          amount: value,
          paymentMethod: p.method,
          paymentDate: p.date || new Date(),
          kind: 'package_receipt',
          status: 'paid',
          serviceType: 'package_session',
          notes: p.description || 'Pagamento do pacote'
        });

        await paymentDoc.save({ session: mongoSession });
        paymentDocs.push(paymentDoc);
        newPackage.payments.push(paymentDoc._id);
        newPackage.totalPaid += value;
        amountPaid += value;
      }
    }

    // Sanitização garantida antes do cálculo
    if (isNaN(newPackage.totalValue) || newPackage.totalValue === undefined || newPackage.totalValue === null) {
      newPackage.totalValue = 0;
    }
    if (isNaN(newPackage.totalPaid) || newPackage.totalPaid === undefined || newPackage.totalPaid === null) {
      newPackage.totalPaid = 0;
    }

    newPackage.balance = newPackage.totalValue - newPackage.totalPaid;
    newPackage.financialStatus =
      newPackage.balance <= 0 ? 'paid' :
        newPackage.totalPaid > 0 ? 'partially_paid' : 'unpaid';

    // 🔢 Soma dos pagos migrados (sessão/appointment avulsos convertidos)
    const migratedPaid = await Payment.aggregate([
      {
        $match: {
          package: newPackage._id,
          status: 'paid',
          kind: 'package_receipt',
          serviceType: 'package_session',
          migratedFrom: { $exists: true }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).session(mongoSession);

    const migratedTotal = migratedPaid?.[0]?.total || 0;

    const migratedIds = await Payment.find({
      package: newPackage._id,
      status: 'paid',
      kind: 'package_receipt',
      serviceType: 'package_session',
      migratedFrom: { $exists: true }
    }, { _id: 1 }).session(mongoSession);

    if (migratedIds.length) {
      await Package.updateOne(
        { _id: newPackage._id },
        { $addToSet: { payments: { $each: migratedIds.map(p => p._id) } } },
        { session: mongoSession }
      );
    }

    // Agora some no totalPaid do pacote ANTES da finalização
    newPackage.totalPaid = (newPackage.totalPaid || 0) + migratedTotal;
    newPackage.balance = (newPackage.totalValue || 0) - (newPackage.totalPaid || 0);
    newPackage.financialStatus =
      newPackage.balance <= 0 ? 'paid' :
        newPackage.totalPaid > 0 ? 'partially_paid' : 'unpaid';

    await newPackage.save({ session: mongoSession });

    // ==========================================================
    // 7️⃣ FINALIZAÇÃO
    // ==========================================================
    await mongoSession.commitTransaction();
    transactionCommitted = true;

    // Atualiza o pacote com todas as referências
    await Package.findByIdAndUpdate(newPackage._id, {
      $set: {
        sessions: insertedSessions.map(s => s._id),
        appointments: insertedAppointments.map(a => a._id)
      }
    });

    // Recarrega o pacote completo para garantir consistência
    const freshPackage = await Package.findById(newPackage._id)
      .populate('sessions appointments payments')
      .lean();

    await syncEvent(freshPackage, 'package');

    // 🕐 Aguarda propagação de visibilidade do Mongo
    await new Promise(resolve => setTimeout(resolve, 250));

    // Recarrega o pacote direto do banco, sem cache
    const reloadedPackage = await Package.findById(newPackage._id).lean();

    // 💸 Distribui também o valor migrado (convertidos do avulso → pacote)
    if (migratedTotal > 0 && paymentType !== 'per-session') {
      try {
        await distributePayments(reloadedPackage._id, migratedTotal, null, null);
      } catch (e) {
        logger.error(`⚠️ Erro ao distribuir valor migrado: ${e.message}`);
      }
    }

    // 💰 Distribui pagamentos após garantir consistência total
    if (paymentType !== 'per-session') {
      for (const p of paymentDocs) {
        try {
          await distributePayments(reloadedPackage._id, p.amount, null, p._id);
        } catch (e) {
          logger.error(`⚠️ Erro ao distribuir pagamento ${p._id}: ${e.message}`);
        }
      }
    } else {
      logger.info(`[CREATE PACKAGE] Modo 'per-session' - distribuição de pagamentos ignorada`);
    }

    // Publica evento de sucesso
    await publishEvent(EventTypes.PACKAGE_CREATED, {
      patientId,
      packageId: newPackage._id.toString(),
      doctorId,
      type: type || 'therapy',
      totalSessions: finalTotalSessions,
      sessionsCreated: insertedSessions?.length || 0,
      requestId
    }, { correlationId });

    logger.info('[PackageProcessingWorker] Package created', {
      correlationId,
      packageId: newPackage._id.toString(),
      patientId,
      sessionsCount: insertedSessions.length
    });

    return {
      operation: 'package_created',
      packageId: newPackage._id.toString(),
      sessionsCount: insertedSessions.length,
      requestId
    };

  } catch (error) {
    if (!transactionCommitted && mongoSession.inTransaction()) {
      await mongoSession.abortTransaction();
    }
    throw error;
  } finally {
    mongoSession.endSession();
  }
}

// ============================================
// EVENT HANDLERS
// ============================================

packageProcessingWorker.on('completed', (job, result) => {
  if (result.status !== 'already_processed') {
    logger.info('[PackageProcessingWorker] Job completed', {
      jobId: job.id,
      eventType: job.data.eventType,
      result: result.operation
    });
  }
});

packageProcessingWorker.on('failed', (job, err) => {
  logger.error('[PackageProcessingWorker] Job failed', {
    jobId: job.id,
    eventType: job.data.eventType,
    error: err.message,
    attempts: job.attemptsMade
  });
});

export default packageProcessingWorker;
