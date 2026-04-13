// back/domains/clinical/services/appointmentService.js
/**
 * Appointment Service - Clinical Domain
 * 
 * Service responsável por operações de Appointment.
 * Este é o orquestrador que coordena Patient + Session + Appointment.
 * 
 * NOTA: Este service trabalha em conjunto com o fluxo V2 existente,
 * mas fornece uma interface limpa para os controllers.
 */

import Appointment from '../../../models/Appointment.js';
import { appendEvent } from '../../../infrastructure/events/eventStoreService.js';
import { createContextLogger } from '../../../utils/logger.js';
import { buildDayRange, buildDateTime } from '../../../utils/datetime.js';
import crypto from 'crypto';

async function checkDoubleBooking({ doctorId, patientId, date, time, excludeId = null }) {
  // 🚨 FIX: Usar helper padronizado para range de busca (timezone-safe)
  // date pode ser string "YYYY-MM-DD" ou Date
  const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
  const baseQuery = {
    date: buildDayRange(dateStr),
    time,
    operationalStatus: { $nin: ['cancelled', 'canceled', 'rejected'] },
  };
  if (excludeId) baseQuery._id = { $ne: excludeId };

  const [doctorConflict, patientConflict] = await Promise.all([
    Appointment.findOne({ ...baseQuery, doctor: doctorId }).select('_id').lean(),
    Appointment.findOne({ ...baseQuery, patient: patientId }).select('_id').lean(),
  ]);

  if (doctorConflict) {
    const err = new Error('SLOT_TAKEN');
    err.code = 'SLOT_TAKEN';
    err.conflictId = doctorConflict._id.toString();
    throw err;
  }

  if (patientConflict) {
    const err = new Error('PATIENT_DOUBLE_BOOKING');
    err.code = 'PATIENT_DOUBLE_BOOKING';
    err.conflictId = patientConflict._id.toString();
    throw err;
  }
}

const log = createContextLogger('AppointmentService');

/**
 * Event Types de Appointment
 */
export const AppointmentEventTypes = {
  APPOINTMENT_SCHEDULED: 'APPOINTMENT_SCHEDULED',
  APPOINTMENT_CONFIRMED: 'APPOINTMENT_CONFIRMED',
  APPOINTMENT_RESCHEDULED: 'APPOINTMENT_RESCHEDULED',
  APPOINTMENT_CANCELLED: 'APPOINTMENT_CANCELLED',
  APPOINTMENT_COMPLETED: 'APPOINTMENT_COMPLETED'
};

/**
 * Cria um agendamento completo (Appointment + Session)
 * 
 * @param {Object} data - Dados do agendamento
 * @param {Object} context - Contexto
 * @returns {Promise<{appointment: Object, event: Object}>}
 */
export async function scheduleAppointment(data, context = {}) {
  const { 
    userId, 
    correlationId = crypto.randomUUID()
  } = context;
  
  const {
    patientId,
    doctorId,
    date,
    time,
    specialty = 'fonoaudiologia',
    serviceType = 'session',
    packageId = null,
    insuranceGuideId = null,
    notes = ''
  } = data;
  
  log.info({ correlationId, patientId, doctorId, date }, 'Criando agendamento');

  // 🚨 FIX: Converter data para Date com timezone BRT antes de salvar
  const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
  const dateTime = buildDateTime(dateStr, time);
  
  await checkDoubleBooking({ doctorId, patientId, date: dateStr, time });

  // 1. Cria appointment
  const appointment = await Appointment.create({
    patient: patientId,
    doctor: doctorId,
    date: dateTime,  // 🚨 FIX: Date com timezone BRT
    time,
    specialty,
    serviceType,
    package: packageId,
    insuranceGuide: insuranceGuideId,
    operationalStatus: 'scheduled',
    clinicalStatus: 'pending',
    paymentStatus: 'pending',
    notes,
    correlationId,
    createdBy: userId,
    createdAt: new Date(),
    history: [{
      action: 'appointment_scheduled',
      newStatus: 'scheduled',
      changedBy: userId,
      timestamp: new Date(),
      context: `Agendamento criado via clinical service`
    }]
  });
  
  // 2. Publica evento
  const event = await appendEvent({
    eventId: `apt_schedule_${appointment._id}_${Date.now()}`,
    eventType: AppointmentEventTypes.APPOINTMENT_SCHEDULED,
    aggregateType: 'appointment',
    aggregateId: appointment._id.toString(),
    payload: {
      appointmentId: appointment._id.toString(),
      patientId: patientId?.toString(),
      doctorId: doctorId?.toString(),
      date,
      time,
      specialty,
      serviceType,
      packageId: packageId?.toString(),
      insuranceGuideId: insuranceGuideId?.toString()
    },
    metadata: {
      correlationId,
      userId,
      source: 'appointmentService.scheduleAppointment'
    }
  });
  
  log.info({ 
    correlationId, 
    appointmentId: appointment._id,
    eventId: event.eventId 
  }, 'Agendamento criado');
  
  return { appointment, event };
}

/**
 * Confirma um agendamento (paciente confirmou presença)
 * 
 * @param {string} appointmentId - ID do agendamento
 * @param {Object} context - Contexto
 * @returns {Promise<{appointment: Object, event: Object}>}
 */
export async function confirmAppointment(appointmentId, context = {}) {
  const { userId, correlationId = crypto.randomUUID() } = context;
  
  log.info({ correlationId, appointmentId }, 'Confirmando agendamento');
  
  const appointment = await Appointment.findByIdAndUpdate(
    appointmentId,
    {
      operationalStatus: 'confirmed',
      confirmedAt: new Date(),
      updatedBy: userId,
      updatedAt: new Date(),
      $push: {
        history: {
          action: 'appointment_confirmed',
          newStatus: 'confirmed',
          changedBy: userId,
          timestamp: new Date()
        }
      }
    },
    { new: true }
  );
  
  if (!appointment) {
    throw new Error('AGENDAMENTO_NAO_ENCONTRADO');
  }
  
  const event = await appendEvent({
    eventId: `apt_confirm_${appointmentId}_${Date.now()}`,
    eventType: AppointmentEventTypes.APPOINTMENT_CONFIRMED,
    aggregateType: 'appointment',
    aggregateId: appointmentId,
    payload: {
      appointmentId,
      patientId: appointment.patient?.toString(),
      doctorId: appointment.doctor?.toString(),
      date: appointment.date,
      confirmedAt: new Date()
    },
    metadata: {
      correlationId,
      userId,
      source: 'appointmentService.confirmAppointment'
    }
  });
  
  return { appointment, event };
}

/**
 * Remarca um agendamento (altera data/hora)
 * 
 * @param {string} appointmentId - ID do agendamento
 * @param {Object} newData - Nova data/hora
 * @param {Object} context - Contexto
 * @returns {Promise<{appointment: Object, event: Object}>}
 */
export async function rescheduleAppointment(appointmentId, newData, context = {}) {
  const { userId, correlationId = crypto.randomUUID(), reason = '' } = context;
  const { date, time } = newData;
  
  log.info({ correlationId, appointmentId, newDate: date, newTime: time }, 'Remarcando agendamento');
  
  // Busca dados antigos para o evento
  const oldAppointment = await Appointment.findById(appointmentId).lean();
  
  if (!oldAppointment) {
    throw new Error('AGENDAMENTO_NAO_ENCONTRADO');
  }

  await checkDoubleBooking({
    doctorId:  oldAppointment.doctor,
    patientId: oldAppointment.patient,
    date,
    time,
    excludeId: appointmentId,
  });

  const appointment = await Appointment.findByIdAndUpdate(
    appointmentId,
    {
      date,
      time,
      operationalStatus: 'rescheduled',
      rescheduledAt: new Date(),
      previousDate: oldAppointment.date,
      previousTime: oldAppointment.time,
      updatedBy: userId,
      updatedAt: new Date(),
      $push: {
        history: {
          action: 'appointment_rescheduled',
          previousDate: oldAppointment.date,
          previousTime: oldAppointment.time,
          newDate: date,
          newTime: time,
          reason,
          changedBy: userId,
          timestamp: new Date()
        }
      }
    },
    { new: true }
  );
  
  const event = await appendEvent({
    eventId: `apt_reschedule_${appointmentId}_${Date.now()}`,
    eventType: AppointmentEventTypes.APPOINTMENT_RESCHEDULED,
    aggregateType: 'appointment',
    aggregateId: appointmentId,
    payload: {
      appointmentId,
      patientId: appointment.patient?.toString(),
      doctorId: appointment.doctor?.toString(),
      previousDate: oldAppointment.date,
      previousTime: oldAppointment.time,
      newDate: date,
      newTime: time,
      reason
    },
    metadata: {
      correlationId,
      userId,
      source: 'appointmentService.rescheduleAppointment'
    }
  });
  
  log.info({ correlationId, appointmentId, eventId: event.eventId }, 'Agendamento remarcado');
  
  return { appointment, event };
}

/**
 * Cancela um agendamento
 * 
 * @param {string} appointmentId - ID do agendamento
 * @param {Object} data - Dados do cancelamento
 * @param {Object} context - Contexto
 * @returns {Promise<{appointment: Object, event: Object}>}
 */
export async function cancelAppointment(appointmentId, data = {}, context = {}) {
  const { 
    userId, 
    correlationId = crypto.randomUUID(),
    reason = '',
    notifyPatient = true
  } = context;
  
  log.info({ correlationId, appointmentId, reason }, 'Cancelando agendamento');
  
  const appointment = await Appointment.findByIdAndUpdate(
    appointmentId,
    {
      operationalStatus: 'cancelled',
      clinicalStatus: 'cancelled',
      cancelledAt: new Date(),
      cancelReason: reason,
      updatedBy: userId,
      updatedAt: new Date(),
      $push: {
        history: {
          action: 'appointment_cancelled',
          newStatus: 'cancelled',
          reason,
          notifyPatient,
          changedBy: userId,
          timestamp: new Date()
        }
      }
    },
    { new: true }
  );
  
  if (!appointment) {
    throw new Error('AGENDAMENTO_NAO_ENCONTRADO');
  }
  
  const event = await appendEvent({
    eventId: `apt_cancel_${appointmentId}_${Date.now()}`,
    eventType: AppointmentEventTypes.APPOINTMENT_CANCELLED,
    aggregateType: 'appointment',
    aggregateId: appointmentId,
    payload: {
      appointmentId,
      patientId: appointment.patient?.toString(),
      doctorId: appointment.doctor?.toString(),
      date: appointment.date,
      time: appointment.time,
      reason,
      notifyPatient,
      cancelledAt: new Date()
    },
    metadata: {
      correlationId,
      userId,
      source: 'appointmentService.cancelAppointment'
    }
  });
  
  log.info({ correlationId, appointmentId, eventId: event.eventId }, 'Agendamento cancelado');
  
  return { appointment, event };
}

/**
 * Busca agendamento por ID
 * 
 * @param {string} appointmentId - ID do agendamento
 * @param {Object} context - Contexto
 * @returns {Promise<Object|null>}
 */
export async function findAppointmentById(appointmentId, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, appointmentId }, 'Buscando agendamento por ID');
  
  const appointment = await Appointment.findById(appointmentId)
    .populate('patient doctor package session payment')
    .lean();
  
  return appointment;
}

/**
 * Busca agendamentos por paciente
 * 
 * @param {string} patientId - ID do paciente
 * @param {Object} filters - Filtros (status, date range)
 * @param {Object} context - Contexto
 * @returns {Promise<Array>}
 */
export async function findAppointmentsByPatient(patientId, filters = {}, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, patientId, filters }, 'Buscando agendamentos do paciente');
  
  const query = { patient: patientId };
  
  if (filters.status) {
    query.operationalStatus = filters.status;
  }
  
  if (filters.dateFrom || filters.dateTo) {
    query.date = {};
    if (filters.dateFrom) query.date.$gte = filters.dateFrom;
    if (filters.dateTo) query.date.$lte = filters.dateTo;
  }
  
  const appointments = await Appointment.find(query)
    .populate('doctor', 'name specialty')
    .sort({ date: -1, time: -1 })
    .lean();
  
  return appointments;
}

/**
 * Busca agendamentos por médico
 * 
 * @param {string} doctorId - ID do médico
 * @param {Object} filters - Filtros (date range, status)
 * @param {Object} context - Contexto
 * @returns {Promise<Array>}
 */
export async function findAppointmentsByDoctor(doctorId, filters = {}, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, doctorId, filters }, 'Buscando agendamentos do médico');
  
  const query = { doctor: doctorId };
  
  if (filters.status) {
    query.operationalStatus = filters.status;
  }
  
  if (filters.dateFrom || filters.dateTo) {
    query.date = {};
    if (filters.dateFrom) query.date.$gte = filters.dateFrom;
    if (filters.dateTo) query.date.$lte = filters.dateTo;
  }
  
  const appointments = await Appointment.find(query)
    .populate('patient', 'fullName phone')
    .sort({ date: 1, time: 1 })
    .lean();
  
  return appointments;
}

/**
 * Busca próximo agendamento do paciente
 * 
 * @param {string} patientId - ID do paciente
 * @param {Object} context - Contexto
 * @returns {Promise<Object|null>}
 */
export async function findNextAppointment(patientId, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, patientId }, 'Buscando próximo agendamento');
  
  const today = new Date().toISOString().split('T')[0];
  
  const appointment = await Appointment.findOne({
    patient: patientId,
    date: { $gte: today },
    operationalStatus: { $nin: ['cancelled', 'completed'] }
  })
    .populate('doctor', 'name')
    .sort({ date: 1, time: 1 })
    .lean();
  
  return appointment;
}

// Exporta service completo
export const AppointmentService = {
  scheduleAppointment,
  confirmAppointment,
  rescheduleAppointment,
  cancelAppointment,
  findAppointmentById,
  findAppointmentsByPatient,
  findAppointmentsByDoctor,
  findNextAppointment,
  AppointmentEventTypes
};

export default AppointmentService;
