// back/services/appointmentV2Service.js
/**
 * Appointment V2 Service
 *
 * Fachada fina que delega todas as operações de escrita para commands
 * especializados em back/services/appointment/commands/.
 *
 * Responsabilidades:
 * - Manter a assinatura pública estável para as rotas V2
 * - Orquestrar commands sem implementar lógica de negócio
 */

import createAppointmentCommand from './appointment/commands/createAppointmentCommand.js';
import updateAppointmentCommand from './appointment/commands/updateAppointmentCommand.js';
import cancelAppointmentCommand from './appointment/commands/cancelAppointmentCommand.js';
import confirmAppointmentCommand from './appointment/commands/confirmAppointmentCommand.js';
import clinicalStatusCommand from './appointment/commands/clinicalStatusCommand.js';
import deleteAppointmentCommand from './appointment/commands/deleteAppointmentCommand.js';
import postAppointmentCommand from './appointment/commands/postAppointmentCommand.js';

export async function createAppointment(payload, user, res = null) {
  return createAppointmentCommand.execute(payload, user, res);
}

export async function updateAppointment(id, payload, user) {
  return updateAppointmentCommand.execute(id, payload, user);
}

export async function cancelAppointment(id, data, user) {
  return cancelAppointmentCommand.execute(id, data, user);
}

export async function confirmAppointment(id, user) {
  return confirmAppointmentCommand.execute(id, user);
}

export async function updateClinicalStatus(id, status, user) {
  return clinicalStatusCommand.execute(id, status, user);
}

export async function deleteAppointment(id, user) {
  return deleteAppointmentCommand.execute(id, user);
}

export async function postAppointment(id, step) {
  return postAppointmentCommand.execute(id, step);
}

export default {
  createAppointment,
  updateAppointment,
  cancelAppointment,
  confirmAppointment,
  updateClinicalStatus,
  deleteAppointment,
  postAppointment,
};
