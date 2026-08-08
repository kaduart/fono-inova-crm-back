export const ALLOWED_INITIAL_APPOINTMENT_STATUSES = Object.freeze([
  'pre_agendado',
  'scheduled',
  'confirmed',
]);

export function resolveInitialAppointmentStatus(status) {
  return ALLOWED_INITIAL_APPOINTMENT_STATUSES.includes(status)
    ? status
    : 'pre_agendado';
}

