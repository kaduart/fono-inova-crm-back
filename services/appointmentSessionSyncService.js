// back/services/appointmentSessionSyncService.js
/**
 * Appointment Session Sync Service
 *
 * Responsabilidade única: garantir que Session seja espelho consistente de Appointment.
 *
 * Regra de ouro:
 * - Appointment manda
 * - Session segue
 * - Ninguém mais atualiza Session diretamente fora dos fluxos de Appointment
 */

import Session from '../models/Session.js';

const APPOINTMENT_TO_SESSION_STATUS_MAP = {
  scheduled: 'scheduled',
  pending: 'pending',
  confirmed: 'confirmed',
  completed: 'completed',
  canceled: 'canceled',
  pre_agendado: 'scheduled',
  no_show: 'canceled',
};

function normalizeSessionStatus(operationalStatus) {
  return APPOINTMENT_TO_SESSION_STATUS_MAP[operationalStatus] || operationalStatus || 'scheduled';
}

function toObjectId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return value._id.toString?.() || value._id;
  return value.toString?.() || value;
}

/**
 * Sincroniza a Session vinculada a partir do estado atual do Appointment.
 *
 * @param {Object} appointment - documento Appointment (pode ser Mongoose doc ou plain object)
 * @param {mongoose.ClientSession|null} mongoSession - sessão de transação opcional
 * @returns {Promise<Object|null>} - Session atualizada ou null se não houver session vinculada
 */
export async function syncSessionFromAppointment(appointment, mongoSession = null) {
  if (!appointment?.session) {
    return null;
  }

  const sessionId = toObjectId(appointment.session);
  if (!sessionId) {
    return null;
  }

  const update = {
    doctor: toObjectId(appointment.doctor),
    patient: toObjectId(appointment.patient),
    date: appointment.date,
    time: appointment.time,
    specialty: appointment.specialty,
    sessionType: appointment.sessionType || appointment.specialty,
    status: normalizeSessionStatus(appointment.operationalStatus),
    sessionValue: appointment.sessionValue || appointment.paymentAmount || 0,
    paymentMethod: appointment.paymentMethod || null,
    paymentStatus: appointment.paymentStatus || 'pending',
    notes: appointment.notes || '',
    updatedAt: new Date(),
  };

  // Propaga insuranceGuide quando o Appointment tem uma guia definida.
  // Evita sobrescrever um vínculo existente na Session com null.
  if (appointment.insuranceGuide) {
    update.insuranceGuide = toObjectId(appointment.insuranceGuide);
  }

  // Remove campos undefined para não sobrescrever com null acidentalmente
  Object.keys(update).forEach((key) => {
    if (update[key] === undefined) {
      delete update[key];
    }
  });

  const options = { new: true };
  if (mongoSession) {
    options.session = mongoSession;
  }

  const updatedSession = await Session.findByIdAndUpdate(
    sessionId,
    { $set: update },
    options
  );

  if (!updatedSession) {
    console.warn(`[appointmentSessionSyncService] Session ${sessionId} não encontrada para sync`);
    return null;
  }

  console.log(`[appointmentSessionSyncService] Session ${sessionId} sincronizada a partir do appointment ${appointment._id}`);
  return updatedSession;
}

/**
 * Cria uma Session consistente a partir de um Appointment recém-criado.
 *
 * @param {Object} appointment - documento Appointment
 * @param {mongoose.ClientSession|null} mongoSession - sessão de transação opcional
 * @returns {Promise<Object|null>} - Session criada
 */
export async function createSessionFromAppointment(appointment, mongoSession = null) {
  if (!appointment) return null;

  const SessionModel = (await import('../models/Session.js')).default;

  const sessionData = {
    patient: toObjectId(appointment.patient),
    doctor: toObjectId(appointment.doctor),
    date: appointment.date,
    time: appointment.time,
    specialty: appointment.specialty,
    sessionType: appointment.sessionType || appointment.specialty,
    status: normalizeSessionStatus(appointment.operationalStatus),
    sessionValue: appointment.sessionValue || appointment.paymentAmount || 0,
    paymentMethod: appointment.paymentMethod || null,
    paymentStatus: appointment.paymentStatus || 'pending',
    notes: appointment.notes || '',
    appointmentId: appointment._id,
    package: toObjectId(appointment.package),
    isPaid: ['package_paid', 'paid'].includes(appointment.paymentStatus),
  };

  const options = {};
  if (mongoSession) {
    options.session = mongoSession;
  }

  const newSession = await SessionModel.create([sessionData], options);
  return newSession[0];
}

export default {
  syncSessionFromAppointment,
  createSessionFromAppointment,
};
