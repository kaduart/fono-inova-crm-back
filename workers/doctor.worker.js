// back/workers/doctor.worker.js
/**
 * Worker de Processamento de Médicos (V2)
 * 
 * Processa eventos:
 * - DOCTOR_CREATE_REQUESTED
 * - DOCTOR_UPDATE_REQUESTED
 * - DOCTOR_DELETE_REQUESTED
 * - DOCTOR_DEACTIVATE_REQUESTED
 * - DOCTOR_REACTIVATE_REQUESTED
 */

import dotenv from "dotenv";
dotenv.config();

import { Worker } from "bullmq";
import chalk from "chalk";
import mongoose from "mongoose";

import Doctor from "../models/Doctor.js";
import { doctorQueue } from "../config/bullConfig.js";

await mongoose.connect(process.env.MONGO_URI);

const worker = new Worker(
  doctorQueue.name,
  async (job) => {
    const { eventType, payload, correlationId } = job.data;
    
    console.log(chalk.cyan(`[DOCTOR WORKER] Processando ${eventType} - Job: ${job.id}`));
    
    try {
      switch (eventType) {
        case 'DOCTOR_CREATE_REQUESTED':
          return await handleCreate(payload, correlationId);
          
        case 'DOCTOR_UPDATE_REQUESTED':
          return await handleUpdate(payload, correlationId);
          
        case 'DOCTOR_DELETE_REQUESTED':
          return await handleDelete(payload, correlationId);
          
        case 'DOCTOR_DEACTIVATE_REQUESTED':
          return await handleDeactivate(payload, correlationId);
          
        case 'DOCTOR_REACTIVATE_REQUESTED':
          return await handleReactivate(payload, correlationId);
          
        default:
          console.warn(chalk.yellow(`[DOCTOR WORKER] Evento desconhecido: ${eventType}`));
          return { success: false, error: 'Evento desconhecido' };
      }
    } catch (error) {
      console.error(chalk.red(`[DOCTOR WORKER] Erro no job ${job.id}:`), error);
      throw error; // Re-throw para o BullMQ fazer retry
    }
  },
  {
    connection: doctorQueue.opts.connection,
    concurrency: 5,
  }
);

// ============================================
// HANDLERS
// ============================================

async function handleCreate(payload, correlationId) {
  const { doctorId, fullName, email, password, specialty, licenseNumber, phoneNumber, active, createdBy } = payload;
  
  console.log(chalk.blue(`[DOCTOR WORKER] Criando médico: ${fullName}`));
  
  // Verifica se já existe médico com esse ID (idempotência)
  const existingDoctor = await Doctor.findById(doctorId);
  if (existingDoctor) {
    console.log(chalk.yellow(`[DOCTOR WORKER] Médico ${doctorId} já existe, retornando existente`));
    return { 
      success: true, 
      doctorId: existingDoctor._id.toString(),
      fullName: existingDoctor.fullName,
      alreadyExisted: true
    };
  }
  
  const doctor = new Doctor({
    _id: doctorId,
    fullName: fullName.trim(),
    email: email.toLowerCase().trim(),
    password,
    specialty,
    licenseNumber,
    phoneNumber,
    active: active || 'true',
    role: 'doctor',
    createdBy
  });
  
  await doctor.save();
  
  console.log(chalk.green(`[DOCTOR WORKER] Médico criado: ${doctor._id}`));
  
  return { 
    success: true, 
    doctorId: doctor._id.toString(),
    fullName: doctor.fullName
  };
}

async function handleUpdate(payload, correlationId) {
  const { doctorId, updates, updatedBy } = payload;
  
  console.log(chalk.blue(`[DOCTOR WORKER] Atualizando médico: ${doctorId}`));
  
  const doctor = await Doctor.findByIdAndUpdate(
    doctorId,
    { 
      ...updates,
      updatedAt: new Date(),
      updatedBy
    },
    { new: true }
  );
  
  if (!doctor) {
    throw new Error('Médico não encontrado');
  }
  
  console.log(chalk.green(`[DOCTOR WORKER] Médico atualizado: ${doctor._id}`));
  
  return { 
    success: true, 
    doctorId: doctor._id.toString(),
    fullName: doctor.fullName
  };
}

async function handleDelete(payload, correlationId) {
  const { doctorId, deletedBy, reason } = payload;
  
  console.log(chalk.blue(`[DOCTOR WORKER] Deletando médico: ${doctorId}`));
  
  const doctor = await Doctor.findByIdAndDelete(doctorId);
  
  if (!doctor) {
    throw new Error('Médico não encontrado');
  }
  
  console.log(chalk.green(`[DOCTOR WORKER] Médico deletado: ${doctorId}`));
  
  return { success: true, doctorId };
}

async function handleDeactivate(payload, correlationId) {
  const { doctorId, deactivatedBy } = payload;
  
  console.log(chalk.blue(`[DOCTOR WORKER] Inativando médico: ${doctorId}`));
  
  const doctor = await Doctor.findByIdAndUpdate(
    doctorId,
    { active: 'false', updatedAt: new Date() },
    { new: true }
  );
  
  if (!doctor) {
    throw new Error('Médico não encontrado');
  }
  
  console.log(chalk.green(`[DOCTOR WORKER] Médico inativado: ${doctor._id}`));
  
  return { 
    success: true, 
    doctorId: doctor._id.toString(),
    fullName: doctor.fullName
  };
}

async function handleReactivate(payload, correlationId) {
  const { doctorId, reactivatedBy } = payload;
  
  console.log(chalk.blue(`[DOCTOR WORKER] Reativando médico: ${doctorId}`));
  
  const doctor = await Doctor.findByIdAndUpdate(
    doctorId,
    { active: 'true', updatedAt: new Date() },
    { new: true }
  );
  
  if (!doctor) {
    throw new Error('Médico não encontrado');
  }
  
  console.log(chalk.green(`[DOCTOR WORKER] Médico reativado: ${doctor._id}`));
  
  return { 
    success: true, 
    doctorId: doctor._id.toString(),
    fullName: doctor.fullName
  };
}

// ============================================
// EVENT LISTENERS
// ============================================

worker.on('completed', (job, result) => {
  console.log(chalk.green(`[DOCTOR WORKER] Job ${job.id} completado:`), result);
});

worker.on('failed', (job, err) => {
  console.error(chalk.red(`[DOCTOR WORKER] Job ${job?.id} falhou:`), err.message);
});

console.log(chalk.cyan('[DOCTOR WORKER] Iniciado e aguardando jobs...'));
