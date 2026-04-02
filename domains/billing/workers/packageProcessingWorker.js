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
import { redisConnection } from '../../../infrastructure/queue/queueConfig.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../../../utils/logger.js';
import Package from '../../../models/Package.js';
import Session from '../../../models/Session.js';
import Appointment from '../../../models/Appointment.js';

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

async function handlePackageCreate(payload, correlationId) {
  const mongoSession = await mongoose.startSession();
  let transactionCommitted = false;
  
  try {
    await mongoSession.startTransaction();
    
    const {
      packageId: predefinedPackageId,  // 🆕 Recebe do payload se existir
      patientId,
      doctorId,
      specialty,
      sessionType,
      sessionValue,
      totalSessions,
      selectedSlots = [],
      paymentMethod,
      paymentType,
      type = 'therapy',
      notes,
      requestId
    } = payload;
    
    // Validação básica
    if (!patientId || !doctorId || !totalSessions) {
      throw new Error('Missing required fields: patientId, doctorId, totalSessions');
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
    
    // Cria o package (com ID pré-definido se vier do payload)
    const packageData = {
      _id: predefinedPackageId || new mongoose.Types.ObjectId(),  // 🆕 Usa ID da rota ou gera novo
      patient: patientId,
      doctor: doctorId,
      specialty,
      sessionType,
      sessionValue,
      totalSessions,
      sessionsDone: 0,
      type,
      status: 'active',
      paymentMethod,
      paymentType,
      totalValue: sessionValue * totalSessions,
      totalPaid: 0,
      balance: sessionValue * totalSessions,
      financialStatus: 'unpaid',
      date: selectedSlots[0]?.date ? new Date(selectedSlots[0].date) : new Date(),
      time: selectedSlots[0]?.time || '08:00',
      durationMonths: Math.ceil(totalSessions / 4) || 1,
      sessionsPerWeek: 1,
      notes,
      metadata: {
        requestId,
        correlationId,
        createdAt: new Date()
      }
    };
    
    const newPackage = await Package.create([packageData], { session: mongoSession });
    const packageId = newPackage[0]._id;
    
    // Cria sessões e appointments 1:1 (se tiver slots)
    const createdSessions = [];
    const createdAppointments = [];
    if (selectedSlots.length > 0) {
      for (const slot of selectedSlots) {
        const sessionData = {
          date: slot.date,
          time: slot.time,
          patient: patientId,
          doctor: doctorId,
          package: packageId,
          specialty,
          sessionType,
          sessionValue,
          status: 'scheduled',
          isPaid: false,
          paymentStatus: 'pending',
          visualFlag: 'pending'
        };

        const [newSession] = await Session.create([sessionData], { session: mongoSession });
        createdSessions.push(newSession._id);

        // Cria appointment vinculado diretamente à session
        const [newAppointment] = await Appointment.create([{
          patient: patientId,
          doctor: doctorId,
          date: slot.date,
          time: slot.time,
          specialty,
          session: newSession._id,
          package: packageId,
          serviceType: 'package_session',
          operationalStatus: 'scheduled',
          clinicalStatus: 'pending',
          paymentStatus: 'pending',
          sessionValue,
          billingType: 'particular',
          duration: 40,
          history: []
        }], { session: mongoSession });
        createdAppointments.push(newAppointment._id);

        // Vincula appointmentId na session
        await Session.updateOne(
          { _id: newSession._id },
          { $set: { appointmentId: newAppointment._id } },
          { session: mongoSession }
        );
      }
    }

    // Atualiza package com referências
    await Package.findByIdAndUpdate(
      packageId,
      { sessions: createdSessions, appointments: createdAppointments },
      { session: mongoSession }
    );
    
    await mongoSession.commitTransaction();
    transactionCommitted = true;
    
    // Publica evento de sucesso
    await publishEvent(EventTypes.PACKAGE_CREATED, {
      patientId,
      packageId: packageId.toString(),
      doctorId,
      type,
      totalSessions,
      sessionsCreated: createdSessions.length,
      requestId
    }, { correlationId });
    
    logger.info('[PackageProcessingWorker] Package created', {
      correlationId,
      packageId: packageId.toString(),
      patientId,
      sessionsCount: createdSessions.length
    });
    
    return {
      operation: 'package_created',
      packageId: packageId.toString(),
      sessionsCount: createdSessions.length,
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
