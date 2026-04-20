// back/domains/clinical/services/patientService.js
/**
 * Patient Service - Clinical Domain
 * 
 * Service responsável por operações de Patient com event-driven.
 * Encapsula toda a lógica de criação, consulta e atualização de pacientes.
 * 
 * Regra: Controllers NÃO devem acessar PatientModel diretamente.
 * Use sempre este service.
 */

import Patient from '../../../models/Patient.js';
import { appendEvent, processWithGuarantees } from '../../../infrastructure/events/eventStoreService.js';
import { createContextLogger } from '../../../utils/logger.js';
import crypto from 'crypto';

const log = createContextLogger('PatientService');

/**
 * Event Types do Clinical Domain
 */
export const ClinicalEventTypes = {
  PATIENT_REGISTERED: 'PATIENT_REGISTERED',
  PATIENT_UPDATED: 'PATIENT_UPDATED',
  PATIENT_PHONE_CHANGED: 'PATIENT_PHONE_CHANGED',
  PATIENT_DATA_CONFIRMED: 'PATIENT_DATA_CONFIRMED'
};

/**
 * Cria um novo paciente e publica evento
 * 
 * @param {Object} data - Dados do paciente
 * @param {Object} context - Contexto (userId, correlationId, etc)
 * @returns {Promise<{patient: Object, event: Object}>}
 */
export async function createPatient(data, context = {}) {
  const { userId, correlationId = crypto.randomUUID() } = context;
  
  log.info({ correlationId }, 'Criando novo paciente');
  
  // 1. Cria paciente no MongoDB
  const patient = await Patient.create({
    ...data,
    createdBy: userId,
    createdAt: new Date()
  });
  
  // 2. Publica evento no Event Store
  const event = await appendEvent({
    eventId: `pt_create_${patient._id}_${Date.now()}`,
    eventType: ClinicalEventTypes.PATIENT_REGISTERED,
    aggregateType: 'patient',
    aggregateId: patient._id.toString(),
    payload: {
      patientId: patient._id.toString(),
      fullName: patient.fullName,
      phone: patient.phone,
      email: patient.email,
      dateOfBirth: patient.dateOfBirth,
      specialties: patient.specialties,
      healthPlan: patient.healthPlan
    },
    metadata: {
      correlationId,
      userId,
      source: 'patientService.createPatient'
    }
  });
  
  log.info({ 
    correlationId, 
    patientId: patient._id,
    eventId: event.eventId 
  }, 'Paciente criado e evento publicado');
  
  return { patient, event };
}

/**
 * Busca paciente por telefone (usado pelo WhatsApp)
 * 
 * @param {string} phone - Número de telefone
 * @param {Object} context - Contexto
 * @returns {Promise<Object|null>}
 */
export async function findPatientByPhone(phone, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, phone }, 'Buscando paciente por telefone');
  
  const patient = await Patient.findOne({ phone }).lean();
  
  if (patient) {
    log.debug({ 
      correlationId, 
      patientId: patient._id,
      found: true 
    }, 'Paciente encontrado');
  } else {
    log.debug({ correlationId, found: false }, 'Paciente não encontrado');
  }
  
  return patient;
}

/**
 * Busca paciente por ID
 * 
 * @param {string} patientId - ID do paciente
 * @param {Object} context - Contexto
 * @returns {Promise<Object|null>}
 */
export async function findPatientById(patientId, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, patientId }, 'Buscando paciente por ID');
  
  const patient = await Patient.findById(patientId).lean();
  
  return patient;
}

/**
 * Atualiza dados do paciente e publica evento
 * 
 * @param {string} patientId - ID do paciente
 * @param {Object} data - Dados a atualizar
 * @param {Object} context - Contexto
 * @returns {Promise<{patient: Object, event: Object}>}
 */
export async function updatePatient(patientId, data, context = {}) {
  const { userId, correlationId = crypto.randomUUID() } = context;
  
  log.info({ correlationId, patientId }, 'Atualizando paciente');
  
  // 1. Busca paciente atual (para comparar mudanças)
  const oldPatient = await Patient.findById(patientId).lean();
  
  if (!oldPatient) {
    throw new Error('PACIENTE_NAO_ENCONTRADO');
  }
  
  // 2. Atualiza no MongoDB
  const patient = await Patient.findByIdAndUpdate(
    patientId,
    {
      ...data,
      updatedBy: userId,
      updatedAt: new Date()
    },
    { new: true }
  );
  
  // 3. Detecta mudança de telefone (importante para WhatsApp)
  const phoneChanged = data.phone && data.phone !== oldPatient.phone;
  
  // 4. Publica evento genérico de update
  const event = await appendEvent({
    eventId: `pt_update_${patientId}_${Date.now()}`,
    eventType: ClinicalEventTypes.PATIENT_UPDATED,
    aggregateType: 'patient',
    aggregateId: patientId,
    payload: {
      patientId,
      changes: data,
      previousPhone: phoneChanged ? oldPatient.phone : undefined,
      newPhone: phoneChanged ? data.phone : undefined
    },
    metadata: {
      correlationId,
      userId,
      source: 'patientService.updatePatient',
      phoneChanged
    }
  });
  
  // 5. Se mudou telefone, publica evento específico
  if (phoneChanged) {
    await appendEvent({
      eventId: `pt_phone_${patientId}_${Date.now()}`,
      eventType: ClinicalEventTypes.PATIENT_PHONE_CHANGED,
      aggregateType: 'patient',
      aggregateId: patientId,
      payload: {
        patientId,
        oldPhone: oldPatient.phone,
        newPhone: data.phone
      },
      metadata: {
        correlationId,
        userId,
        source: 'patientService.updatePatient'
      }
    });
  }
  
  log.info({ 
    correlationId, 
    patientId,
    eventId: event.eventId,
    phoneChanged
  }, 'Paciente atualizado e evento publicado');
  
  return { patient, event };
}

/**
 * Confirma dados do paciente (usado quando lead vira paciente)
 * 
 * @param {string} patientId - ID do paciente
 * @param {Object} context - Contexto
 * @returns {Promise<{patient: Object, event: Object}>}
 */
export async function confirmPatientData(patientId, context = {}) {
  const { userId, correlationId = crypto.randomUUID() } = context;
  
  log.info({ correlationId, patientId }, 'Confirmando dados do paciente');
  
  const patient = await Patient.findByIdAndUpdate(
    patientId,
    {
      dataConfirmed: true,
      dataConfirmedAt: new Date(),
      updatedBy: userId,
      updatedAt: new Date()
    },
    { new: true }
  );
  
  if (!patient) {
    throw new Error('PACIENTE_NAO_ENCONTRADO');
  }
  
  const event = await appendEvent({
    eventId: `pt_confirm_${patientId}_${Date.now()}`,
    eventType: ClinicalEventTypes.PATIENT_DATA_CONFIRMED,
    aggregateType: 'patient',
    aggregateId: patientId,
    payload: {
      patientId,
      confirmedAt: new Date(),
      confirmedBy: userId
    },
    metadata: {
      correlationId,
      userId,
      source: 'patientService.confirmPatientData'
    }
  });
  
  return { patient, event };
}

/**
 * Busca múltiplos pacientes por IDs
 * 
 * @param {Array<string>} patientIds - Array de IDs
 * @param {Object} context - Contexto
 * @returns {Promise<Array>}
 */
export async function findPatientsByIds(patientIds, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, count: patientIds.length }, 'Buscando múltiplos pacientes');
  
  const patients = await Patient.find({
    _id: { $in: patientIds }
  }).lean();
  
  return patients;
}

/**
 * Atualiza ou cria paciente (upsert) - útil para WhatsApp
 * 
 * @param {Object} data - Dados do paciente
 * @param {Object} context - Contexto
 * @returns {Promise<{patient: Object, isNew: boolean, event: Object}>}
 */
export async function upsertPatientByPhone(data, context = {}) {
  const { userId, correlationId = crypto.randomUUID() } = context;
  
  log.info({ correlationId, phone: data.phone }, 'Upsert paciente por telefone');
  
  // Tenta encontrar paciente existente
  let patient = await Patient.findOne({ phone: data.phone });
  let isNew = false;
  
  if (patient) {
    // Atualiza existente
    log.debug({ correlationId, patientId: patient._id }, 'Paciente existe, atualizando');
    const result = await updatePatient(patient._id.toString(), data, context);
    return { ...result, isNew: false };
  } else {
    // Cria novo
    log.debug({ correlationId }, 'Paciente não existe, criando novo');
    const result = await createPatient(data, context);
    return { ...result, isNew: true };
  }
}

/**
 * Resolve ou cria paciente a partir de informações cruas (ex: patientInfo de um Appointment).
 * Usado quando um agendamento chega sem patientId (paciente novo da agenda externa).
 *
 * @param {Object} info - Objeto com dados do paciente
 * @param {Object} context - Contexto (userId, correlationId)
 * @returns {Promise<{patient: Object, isNew: boolean}>}
 */
export async function resolvePatientFromInfo(info, context = {}) {
  const { userId, correlationId = crypto.randomUUID() } = context;
  const phone = info.phone || '';
  let patient = null;
  let isNew = false;

  if (phone) {
    patient = await Patient.findOne({ phone }).lean();
  }

  if (!patient && info.fullName) {
    const result = await createPatient({
      fullName: info.fullName,
      phone: phone || undefined,
      email: info.email || undefined,
      dateOfBirth: info.birthDate || info.dateOfBirth || null,
      status: 'active',
      isLead: false
    }, { userId, correlationId });
    patient = result.patient;
    isNew = true;
  }

  return { patient, isNew };
}

// Exporta service completo
export const PatientService = {
  createPatient,
  findPatientByPhone,
  findPatientById,
  updatePatient,
  confirmPatientData,
  findPatientsByIds,
  upsertPatientByPhone,
  resolvePatientFromInfo,
  ClinicalEventTypes
};

export default PatientService;
