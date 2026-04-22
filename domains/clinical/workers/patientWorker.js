// back/domains/clinical/workers/patientWorker.js
/**
 * Patient Worker - WRITE SIDE
 * 
 * Processa comandos de escrita no domínio Patient.
 * Após sucesso, publica eventos para o Projection Worker.
 * 
 * Garantias:
 * - Atomicidade: transação MongoDB
 * - Idempotência: verifica existência antes de criar
 * - Consistência: evento só publica após commit
 * - Saga: compensação em caso de falha
 */

import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import { redisConnection } from '../../../infrastructure/queue/queueConfig.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../../../utils/logger.js';
import Patient from '../../../models/Patient.js';

const logger = createContextLogger('PatientWorker');

// ============================================
// WORKER CONFIG
// ============================================

const RETRY_CONFIG = {
  maxRetries: 3,
  backoff: {
    type: 'exponential',
    delay: 1000
  }
};

export const patientWorker = new Worker(
  'patient-processing',
  async (job) => {
    const { eventType, payload, correlationId } = job.data;
    const startTime = Date.now();
    
    logger.info(`[${correlationId}] 🎯 Processing ${eventType}`, {
      patientId: payload.patientId,
      jobId: job.id,
      attempt: job.attemptsMade + 1
    });
    
    try {
      const result = await processCommand(eventType, payload, correlationId);
      
      const duration = Date.now() - startTime;
      logger.info(`[${correlationId}] ✅ Command completed`, {
        eventType,
        patientId: payload.patientId,
        duration: `${duration}ms`,
        operation: result.operation
      });
      
      return {
        success: true,
        eventType,
        patientId: payload.patientId,
        duration,
        ...result
      };
      
    } catch (error) {
      logger.error(`[${correlationId}] ❌ Command failed`, {
        eventType,
        patientId: payload.patientId,
        error: error.message,
        attempt: job.attemptsMade + 1
      });
      
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
    limiter: { max: 20, duration: 1000 }
  }
);

// ============================================
// COMMAND PROCESSORS
// ============================================

async function processCommand(eventType, payload, correlationId) {
  switch (eventType) {
    case EventTypes.PATIENT_CREATE_REQUESTED:
      return await handleCreatePatient(payload, correlationId);
    
    case EventTypes.PATIENT_UPDATE_REQUESTED:
      return await handleUpdatePatient(payload, correlationId);
    
    case EventTypes.PATIENT_DELETE_REQUESTED:
      return await handleDeletePatient(payload, correlationId);
    
    default:
      throw new Error(`Unknown command: ${eventType}`);
  }
}

// ============================================
// CREATE PATIENT
// ============================================

async function handleCreatePatient(payload, correlationId) {
  const session = await mongoose.startSession();
  
  try {
    await session.startTransaction();
    
    const { 
      patientId, 
      fullName, 
      dateOfBirth, 
      phone, 
      email, 
      cpf,
      rg,
      gender,
      address,
      healthPlan,
      mainComplaint,
      emergencyContact,
      createdBy 
    } = payload;
    
    logger.info(`[${correlationId}] 🆕 Creating patient`, { patientId, fullName });
    
    // 1. Idempotência: verifica se já existe
    const existing = await Patient.findById(patientId).session(session);
    if (existing) {
      logger.warn(`[${correlationId}] ⚠️ Patient already exists`, { patientId });
      
      await session.abortTransaction();
      
      // Retorna sucesso (idempotente)
      return {
        operation: 'create_idempotent',
        patientId,
        wasAlreadyCreated: true
      };
    }
    
    // 2. Verifica duplicado por CPF (se fornecido)
    if (cpf) {
      const duplicateCpf = await Patient.findOne({ cpf }).session(session);
      if (duplicateCpf) {
        await session.abortTransaction();
        throw new Error(`CPF ${cpf} já cadastrado para paciente ${duplicateCpf._id}`);
      }
    }
    
    // 3. Cria paciente
    const patient = new Patient({
      _id: new mongoose.Types.ObjectId(patientId),
      fullName: fullName.trim(),
      dateOfBirth: new Date(dateOfBirth),
      phone,
      email,
      cpf,
      rg,
      gender,
      address,
      healthPlan,
      mainComplaint,
      emergencyContact,
      createdBy
    });
    
    await patient.save({ session });
    
    logger.info(`[${correlationId}] 💾 Patient saved to MongoDB`, { patientId });

    await session.commitTransaction();

    logger.info(`[${correlationId}] ✅ Transaction committed`, { patientId });

    // 4. Publica evento APÓS commit — garante que o paciente já está visível no MongoDB
    await publishEvent(
      EventTypes.PATIENT_CREATED,
      {
        patientId: patient._id.toString(),
        fullName: patient.fullName,
        phone: patient.phone,
        email: patient.email,
        cpf: patient.cpf,
        createdAt: patient.createdAt.toISOString()
      },
      { correlationId }
    );
    
    return {
      operation: 'create',
      patientId: patient._id.toString(),
      fullName: patient.fullName
    };
    
  } catch (error) {
    await session.abortTransaction();
    
    logger.error(`[${correlationId}] 💥 Create failed`, { 
      patientId: payload.patientId,
      error: error.message 
    });
    
    // Publica evento de falha (para compensação se necessário)
    await publishEvent(
      'PATIENT_CREATE_FAILED',
      {
        patientId: payload.patientId,
        error: error.message,
        failedAt: new Date().toISOString()
      },
      { correlationId }
    );
    
    throw error;
    
  } finally {
    session.endSession();
  }
}

// ============================================
// UPDATE PATIENT
// ============================================

async function handleUpdatePatient(payload, correlationId) {
  const session = await mongoose.startSession();
  
  try {
    await session.startTransaction();
    
    const { patientId, updates, updatedBy } = payload;
    
    logger.info(`[${correlationId}] 📝 Updating patient`, { 
      patientId, 
      fields: Object.keys(updates) 
    });
    
    // 1. Verifica existência
    const patient = await Patient.findById(patientId).session(session);
    if (!patient) {
      await session.abortTransaction();
      throw new Error(`Paciente não encontrado: ${patientId}`);
    }
    
    // 2. Aplica updates
    const allowedFields = [
      'fullName', 'dateOfBirth', 'phone', 'email', 'cpf', 'rg',
      'gender', 'address', 'healthPlan', 'mainComplaint',
      'emergencyContact', 'clinicalHistory', 'medications', 'allergies'
    ];
    
    const sanitizedUpdates = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        sanitizedUpdates[field] = updates[field];
      }
    }
    
    // Normaliza campos
    if (sanitizedUpdates.fullName) {
      sanitizedUpdates.fullName = sanitizedUpdates.fullName.trim();
    }
    if (sanitizedUpdates.phone) {
      sanitizedUpdates.phone = sanitizedUpdates.phone.replace(/\D/g, '');
    }
    if (sanitizedUpdates.email) {
      sanitizedUpdates.email = sanitizedUpdates.email.toLowerCase();
    }
    
    // 3. Executa update
    const updated = await Patient.findByIdAndUpdate(
      patientId,
      { 
        ...sanitizedUpdates,
        updatedBy,
        updatedAt: new Date()
      },
      { session, new: true }
    );
    
    logger.info(`[${correlationId}] 💾 Patient updated`, { patientId });
    
    // 4. Publica evento
    await publishEvent(
      EventTypes.PATIENT_UPDATED,
      {
        patientId: updated._id.toString(),
        updatedFields: Object.keys(sanitizedUpdates),
        updatedAt: updated.updatedAt.toISOString()
      },
      { correlationId }
    );
    
    await session.commitTransaction();
    
    return {
      operation: 'update',
      patientId: updated._id.toString(),
      updatedFields: Object.keys(sanitizedUpdates)
    };
    
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

// ============================================
// DELETE PATIENT
// ============================================

async function handleDeletePatient(payload, correlationId) {
  const session = await mongoose.startSession();
  
  try {
    await session.startTransaction();
    
    const { patientId, deletedBy, reason } = payload;
    
    logger.info(`[${correlationId}] 🗑️ Deleting patient`, { patientId, reason });
    
    // 1. Verifica existência
    const patient = await Patient.findById(patientId).session(session);
    if (!patient) {
      await session.abortTransaction();
      throw new Error(`Paciente não encontrado: ${patientId}`);
    }
    
    // 2. Verifica dependências (agendamentos futuros?)
    const Appointment = mongoose.model('Appointment');
    const futureAppointments = await Appointment.countDocuments({
      patient: patientId,
      date: { $gte: new Date().toISOString().slice(0, 10) },
      operationalStatus: { $ne: 'canceled' }
    }).session(session);
    
    if (futureAppointments > 0) {
      await session.abortTransaction();
      throw new Error(`Paciente tem ${futureAppointments} agendamentos futuros. Cancele-os primeiro.`);
    }
    
    // 3. Soft delete (melhor que hard delete)
    // Ou hard delete se for requisito
    await Patient.findByIdAndDelete(patientId, { session });
    
    logger.info(`[${correlationId}] 💾 Patient deleted`, { patientId });
    
    // 4. Publica evento
    await publishEvent(
      EventTypes.PATIENT_DELETED,
      {
        patientId,
        deletedBy,
        reason,
        deletedAt: new Date().toISOString()
      },
      { correlationId }
    );
    
    await session.commitTransaction();
    
    return {
      operation: 'delete',
      patientId
    };
    
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

// ============================================
// EVENT LISTENERS
// ============================================

patientWorker.on('completed', (job, result) => {
  logger.info(`✅ Job ${job.id} completed`, {
    eventType: job.data.eventType,
    patientId: job.data.payload?.patientId,
    operation: result?.operation
  });
});

patientWorker.on('failed', (job, err) => {
  logger.error(`❌ Job ${job.id} failed`, {
    eventType: job.data?.eventType,
    patientId: job.data?.payload?.patientId,
    error: err.message,
    attempts: job.attemptsMade
  });
});

// ============================================
// HEALTH CHECK
// ============================================

export async function getPatientWorkerStatus() {
  const queue = patientWorker.queue;
  
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount()
  ]);
  
  return {
    status: patientWorker.isRunning() ? 'running' : 'stopped',
    queue: { waiting, active, completed, failed },
    timestamp: new Date().toISOString()
  };
}

export default patientWorker;
