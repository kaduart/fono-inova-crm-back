/**
 * Patient Events Contract V2
 * 
 * Contrato oficial de eventos do domínio Clinical (Patient).
 * 
 * Regras:
 * - Todos os eventos devem seguir este contrato
 * - Payloads são validados antes de publicar
 * - Mudanças devem incrementar a versão
 */

import { defineEventContract, V } from '../../../infrastructure/events/eventContractRegistry.js';

export const PatientEventTypes = {
  // ========================================
  // PATIENT LIFECYCLE
  // ========================================
  
  /**
   * Paciente criado no sistema
   * @version 1
   */
  PATIENT_CREATED: {
    type: 'PATIENT_CREATED',
    version: 1,
    required: ['patientId', 'fullName', 'email'],
    optional: ['phone', 'dateOfBirth', 'cpf', 'address'],
    description: 'Novo paciente registrado no sistema',
    queues: ['patient-projection'],
    idempotent: true
  },

  /**
   * Paciente atualizado
   * @version 1
   */
  PATIENT_UPDATED: {
    type: 'PATIENT_UPDATED',
    version: 1,
    required: ['patientId', 'updates'],
    optional: ['updatedBy', 'reason'],
    description: 'Dados do paciente alterados',
    queues: ['patient-projection'],
    idempotent: true
  },

  /**
   * Paciente removido
   * @version 1
   */
  PATIENT_DELETED: {
    type: 'PATIENT_DELETED',
    version: 1,
    required: ['patientId', 'deletedAt'],
    optional: ['deletedBy', 'reason'],
    description: 'Paciente removido logicamente',
    queues: ['patient-projection'],
    idempotent: true
  },

  // ========================================
  // APPOINTMENT EVENTS
  // ========================================
  
  APPOINTMENT_SCHEDULED: {
    type: 'APPOINTMENT_SCHEDULED',
    version: 1,
    required: ['appointmentId', 'patientId', 'scheduledAt'],
    optional: ['professionalId', 'therapyArea'],
    queues: ['patient-projection'],
    idempotent: true
  },

  APPOINTMENT_COMPLETED: {
    type: 'APPOINTMENT_COMPLETED',
    version: 1,
    required: ['appointmentId', 'patientId', 'completedAt'],
    optional: ['sessionId', 'paymentStatus'],
    queues: ['patient-projection', 'sync-medical'],
    idempotent: true
  },

  APPOINTMENT_CANCELED: {
    type: 'APPOINTMENT_CANCELED',
    version: 1,
    required: ['appointmentId', 'patientId', 'canceledAt'],
    optional: ['reason', 'canceledBy'],
    queues: ['patient-projection', 'sync-medical'],
    idempotent: true
  },

  // ========================================
  // SESSION EVENTS
  // ========================================
  
  SESSION_COMPLETED: {
    type: 'SESSION_COMPLETED',
    version: 1,
    required: ['sessionId', 'patientId', 'appointmentId', 'completedAt'],
    optional: ['notes', 'evolutions'],
    queues: ['patient-projection'],
    idempotent: true
  },

  SESSION_PAYMENT_RECEIVED: {
    type: 'SESSION_PAYMENT_RECEIVED',
    version: 1,
    required: ['sessionId', 'patientId', 'paymentId', 'amount'],
    optional: ['paymentMethod', 'packageId'],
    queues: ['patient-projection', 'sync-medical'],
    idempotent: true
  },

  // ========================================
  // PACKAGE EVENTS
  // ========================================
  
  PACKAGE_CREATED: {
    type: 'PACKAGE_CREATED',
    version: 1,
    required: ['packageId', 'patientId', 'totalSessions', 'amount'],
    optional: ['expiresAt', 'therapyArea'],
    queues: ['patient-projection', 'package-processing'],
    idempotent: true
  },

  PACKAGE_CREDIT_CONSUMED: {
    type: 'PACKAGE_CREDIT_CONSUMED',
    version: 1,
    required: ['packageId', 'patientId', 'sessionId', 'consumedAt'],
    optional: ['remainingCredits'],
    queues: ['patient-projection', 'package-validation'],
    idempotent: true
  },

  // ========================================
  // PAYMENT EVENTS
  // ========================================
  
  PAYMENT_RECEIVED: {
    type: 'PAYMENT_RECEIVED',
    version: 1,
    required: ['paymentId', 'patientId', 'amount', 'receivedAt'],
    optional: ['method', 'appointmentId'],
    queues: ['patient-projection', 'balance-update'],
    idempotent: true
  },

  BALANCE_UPDATED: {
    type: 'BALANCE_UPDATED',
    version: 1,
    required: ['patientId', 'newBalance', 'updatedAt'],
    optional: ['previousBalance', 'changeReason'],
    queues: ['patient-projection'],
    idempotent: true
  }
};

/**
 * Valida um payload contra o contrato do evento
 * @param {string} eventType - Tipo do evento
 * @param {Object} payload - Payload a validar
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateEventPayload(eventType, payload) {
  const contract = PatientEventTypes[eventType];
  
  if (!contract) {
    return { valid: false, errors: [`Event type '${eventType}' not found in contract`] };
  }

  const errors = [];

  // Verifica campos obrigatórios
  for (const field of contract.required) {
    if (payload[field] === undefined || payload[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Verifica campos desconhecidos (alerta, não erro)
  const knownFields = [...contract.required, ...contract.optional];
  const unknownFields = Object.keys(payload).filter(f => !knownFields.includes(f));
  
  return {
    valid: errors.length === 0,
    errors,
    warnings: unknownFields.length > 0 ? [`Unknown fields: ${unknownFields.join(', ')}`] : [],
    contract: {
      type: contract.type,
      version: contract.version,
      queues: contract.queues
    }
  };
}

/**
 * Gera idempotencyKey baseada no contrato
 * @param {string} eventType 
 * @param {Object} payload 
 * @returns {string}
 */
export function generateIdempotencyKey(eventType, payload) {
  const contract = PatientEventTypes[eventType];
  if (!contract) return null;

  // Usa patientId + eventType como base
  const patientId = payload.patientId || 'unknown';
  const action = eventType.toLowerCase().replace(/_/g, '-');
  
  // Se tiver campos identificadores específicos, inclui
  const entityId = payload.appointmentId || payload.sessionId || payload.packageId || '';
  
  return entityId 
    ? `patient:${patientId}:${action}:${entityId}`
    : `patient:${patientId}:${action}`;
}

/**
 * Registra todos os contracts de Patient no registry global
 */
export function registerPatientEventContracts() {
  for (const [eventType, contract] of Object.entries(PatientEventTypes)) {
    defineEventContract(eventType, {
      version: contract.version,
      required: contract.required,
      optional: contract.optional,
      description: contract.description,
      validators: {
        patientId: V.isMongoId(),
        appointmentId: V.isOptionalMongoId(),
        sessionId: V.isOptionalMongoId(),
        packageId: V.isOptionalMongoId(),
        paymentId: V.isOptionalMongoId(),
      }
    });
  }
}

export default PatientEventTypes;
