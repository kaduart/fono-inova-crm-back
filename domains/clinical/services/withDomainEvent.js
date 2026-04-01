// back/domains/clinical/services/withDomainEvent.js
/**
 * Wrapper para garantir emissão de eventos em operações de domínio
 * 
 * Regra: Toda operação de write deve usar este wrapper
 */

import { emitDomainEvent } from '../events/patientEvents.js';

/**
 * Executa operação e emite evento automaticamente
 * 
 * @param {string} eventType - Tipo do evento
 * @param {Function} operation - Função async que executa a operação
 * @param {Object} options - Opções
 * @returns {Promise<any>} - Resultado da operação
 */
export async function withDomainEvent(eventType, operation, options = {}) {
  const { 
    getPayload = (result) => result,
    onError = null,
    correlationId = `op_${Date.now()}`
  } = options;
  
  try {
    // 1. Executa operação
    const result = await operation();
    
    // 2. Monta payload do evento
    const payload = getPayload(result);
    
    // 3. Emite evento (não bloqueia retorno)
    emitDomainEvent(eventType, payload, { correlationId })
      .catch(err => {
        console.error(`[withDomainEvent] Failed to emit ${eventType}:`, err.message);
        // Não throw - operação já foi bem-sucedida
      });
    
    return result;
    
  } catch (error) {
    // Emite evento de erro se configurado
    if (onError) {
      await onError(error);
    }
    throw error;
  }
}

/**
 * Wrapper específico para Patient
 */
export async function withPatientEvent(eventType, operation, options = {}) {
  return withDomainEvent(eventType, operation, {
    ...options,
    getPayload: (result) => ({
      patientId: result._id?.toString() || result.patientId,
      fullName: result.fullName,
      phone: result.phone,
      email: result.email,
      createdAt: result.createdAt?.toISOString() || new Date().toISOString(),
      ...options.additionalPayload
    })
  });
}

/**
 * Wrapper específico para Appointment
 */
export async function withAppointmentEvent(eventType, operation, options = {}) {
  return withDomainEvent(eventType, operation, {
    ...options,
    getPayload: (result) => ({
      appointmentId: result._id?.toString() || result.appointmentId,
      patientId: result.patient?.toString() || result.patientId,
      doctorId: result.doctor?.toString() || result.doctorId,
      date: result.date,
      time: result.time,
      serviceType: result.serviceType,
      status: result.operationalStatus || result.status,
      createdAt: result.createdAt?.toISOString() || new Date().toISOString(),
      ...options.additionalPayload
    })
  });
}

/**
 * Wrapper específico para Payment
 */
export async function withPaymentEvent(eventType, operation, options = {}) {
  return withDomainEvent(eventType, operation, {
    ...options,
    getPayload: (result) => ({
      paymentId: result._id?.toString() || result.paymentId,
      patientId: result.patient?.toString() || result.patientId,
      appointmentId: result.appointment?.toString() || result.appointmentId,
      amount: result.amount,
      paymentMethod: result.paymentMethod,
      receivedAt: result.paidAt?.toISOString() || result.createdAt?.toISOString() || new Date().toISOString(),
      ...options.additionalPayload
    })
  });
}

export default withDomainEvent;
