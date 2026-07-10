/**
 * Normaliza payload da Agenda Externa para o formato esperado por updateAppointmentCommand.
 *
 * A Agenda Externa envia campos no formato visual do modal (patientId, patientName,
 * professionalId, specialtyKey, observations etc.). Esta função converte para os
 * nomes de campo que o command de update do Appointment entende (patient, doctorId,
 * specialty, patientInfo, notes etc.).
 */

export function normalizeAdminEditPayload(body) {
  const {
    patientId,
    patientName,
    phone,
    birthDate,
    email,
    professionalId,
    doctorId,
    professionalName,
    specialty,
    specialtyKey,
    observations,
    adminReason,
    ...remainingFields
  } = body || {};

  return {
    ...remainingFields,
    ...(patientId && { patient: patientId }),
    doctorId: doctorId || professionalId || remainingFields.doctorId,
    specialty: specialty || specialtyKey || remainingFields.specialty,
    professionalName: professionalName || remainingFields.professionalName,
    ...(patientName || phone || birthDate || email
      ? {
          patientInfo: {
            ...(patientName && { fullName: patientName }),
            ...(phone && { phone }),
            ...(birthDate && { birthDate }),
            ...(email && { email }),
          },
        }
      : {}),
    notes: observations || remainingFields.notes,
    ...(adminReason && { adminReason }),
  };
}
