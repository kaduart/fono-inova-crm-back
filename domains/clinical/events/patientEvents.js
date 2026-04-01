// back/domains/clinical/events/patientEvents.js
/**
 * Patient Domain Events - CONTRATO OFICIAL
 * 
 * Regra de Ouro: TODA operação de write em Patient/Appointment/Payment
 * DEVE emitir um evento deste arquivo.
 */

// ============================================
// PATIENT LIFECYCLE
// ============================================

export const PatientEvents = {
  /**
   * Patient criado
   * Emitido por: patientService.create, patientWorker
   */
  PATIENT_CREATED: {
    type: 'PATIENT_CREATED',
    version: '1.0',
    payload: {
      patientId: { type: 'string', required: true },
      fullName: { type: 'string', required: true },
      phone: { type: 'string', required: false },
      email: { type: 'string', required: false },
      dateOfBirth: { type: 'date', required: false },
      createdAt: { type: 'datetime', required: true },
      createdBy: { type: 'string', required: false }
    }
  },

  /**
   * Patient atualizado
   * Emitido por: patientService.update, patientWorker
   */
  PATIENT_UPDATED: {
    type: 'PATIENT_UPDATED',
    version: '1.0',
    payload: {
      patientId: { type: 'string', required: true },
      updatedFields: { type: 'array', required: true },
      updatedAt: { type: 'datetime', required: true },
      updatedBy: { type: 'string', required: false }
    }
  },

  /**
   * Patient deletado
   * Emitido por: patientService.delete, patientWorker
   */
  PATIENT_DELETED: {
    type: 'PATIENT_DELETED',
    version: '1.0',
    payload: {
      patientId: { type: 'string', required: true },
      deletedAt: { type: 'datetime', required: true },
      deletedBy: { type: 'string', required: false },
      reason: { type: 'string', required: false }
    }
  }
};

// ============================================
// APPOINTMENT LIFECYCLE (afeta PatientView)
// ============================================

export const AppointmentEvents = {
  /**
   * Appointment criado
   * Emitido por: appointmentService.create
   */
  APPOINTMENT_CREATED: {
    type: 'APPOINTMENT_CREATED',
    version: '1.0',
    payload: {
      appointmentId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      doctorId: { type: 'string', required: true },
      date: { type: 'date', required: true },
      time: { type: 'string', required: true },
      serviceType: { type: 'string', required: true },
      status: { type: 'string', required: true },
      createdAt: { type: 'datetime', required: true }
    }
  },

  /**
   * Appointment completado
   * Emitido por: appointmentService.complete, completeOrchestratorWorker
   * IMPACTO: Atualiza lastAppointment, totalCompleted
   */
  APPOINTMENT_COMPLETED: {
    type: 'APPOINTMENT_COMPLETED',
    version: '1.0',
    payload: {
      appointmentId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      doctorId: { type: 'string', required: true },
      date: { type: 'date', required: true },
      completedAt: { type: 'datetime', required: true },
      serviceType: { type: 'string', required: true }
    }
  },

  /**
   * Appointment cancelado
   * Emitido por: appointmentService.cancel, cancelOrchestratorWorker
   * IMPACTO: Atualiza stats
   */
  APPOINTMENT_CANCELLED: {
    type: 'APPOINTMENT_CANCELLED',
    version: '1.0',
    payload: {
      appointmentId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      cancelledAt: { type: 'datetime', required: true },
      reason: { type: 'string', required: false }
    }
  },

  /**
   * Appointment remarcado
   * Emitido por: appointmentService.reschedule
   * IMPACTO: Atualiza nextAppointment
   */
  APPOINTMENT_RESCHEDULED: {
    type: 'APPOINTMENT_RESCHEDULED',
    version: '1.0',
    payload: {
      appointmentId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      previousDate: { type: 'date', required: true },
      newDate: { type: 'date', required: true },
      rescheduledAt: { type: 'datetime', required: true }
    }
  }
};

// ============================================
// PAYMENT LIFECYCLE (afeta PatientView)
// ============================================

export const PaymentEvents = {
  /**
   * Pagamento recebido
   * Emitido por: paymentService.create, paymentWorker
   * IMPACTO: Atualiza totalRevenue, balance
   */
  PAYMENT_RECEIVED: {
    type: 'PAYMENT_RECEIVED',
    version: '1.0',
    payload: {
      paymentId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      appointmentId: { type: 'string', required: false },
      amount: { type: 'number', required: true },
      paymentMethod: { type: 'string', required: true },
      receivedAt: { type: 'datetime', required: true }
    }
  },

  /**
   * Pagamento reembolsado
   * Emitido por: paymentService.refund
   * IMPACTO: Atualiza totalRevenue
   */
  PAYMENT_REFUNDED: {
    type: 'PAYMENT_REFUNDED',
    version: '1.0',
    payload: {
      paymentId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      amount: { type: 'number', required: true },
      refundedAt: { type: 'datetime', required: true }
    }
  }
};

// ============================================
// PACKAGE LIFECYCLE (afeta PatientView)
// ============================================

export const PackageEvents = {
  /**
   * Pacote criado
   * Emitido por: packageService.create
   */
  PACKAGE_CREATED: {
    type: 'PACKAGE_CREATED',
    version: '1.0',
    payload: {
      packageId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      sessionType: { type: 'string', required: true },
      totalSessions: { type: 'number', required: true },
      createdAt: { type: 'datetime', required: true }
    }
  },

  /**
   * Crédito de sessão consumido
   * Emitido por: packageService.consumeSession, packageValidationWorker
   * IMPACTO: Atualiza totalSessions
   */
  PACKAGE_CREDIT_CONSUMED: {
    type: 'PACKAGE_CREDIT_CONSUMED',
    version: '1.0',
    payload: {
      packageId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      appointmentId: { type: 'string', required: true },
      sessionsRemaining: { type: 'number', required: true },
      consumedAt: { type: 'datetime', required: true }
    }
  },

  /**
   * Crédito restaurado (cancelamento)
   * Emitido por: packageService.restoreCredit
   * IMPACTO: Atualiza totalSessions
   */
  PACKAGE_CREDIT_RESTORED: {
    type: 'PACKAGE_CREDIT_RESTORED',
    version: '1.0',
    payload: {
      packageId: { type: 'string', required: true },
      patientId: { type: 'string', required: true },
      appointmentId: { type: 'string', required: true },
      sessionsRemaining: { type: 'number', required: true },
      restoredAt: { type: 'datetime', required: true }
    }
  }
};

// ============================================
// HELPER: Emissão de eventos
// ============================================

import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';

/**
 * Emite evento de domínio com validação
 */
export async function emitDomainEvent(eventType, payload, options = {}) {
  const { correlationId = `evt_${Date.now()}` } = options;
  
  console.log(`[DomainEvent] Emitting ${eventType}`, {
    correlationId,
    patientId: payload.patientId
  });
  
  return await publishEvent(eventType, payload, { correlationId });
}

// Exporta todos os eventos
export const AllPatientEvents = {
  ...PatientEvents,
  ...AppointmentEvents,
  ...PaymentEvents,
  ...PackageEvents
};

export default AllPatientEvents;
