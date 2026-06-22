// back/services/appointment/commands/clinicalStatusCommand.js
/**
 * Clinical Status Command
 *
 * Responsabilidade: atualizar o status clínico de um agendamento,
 * refletindo-o no status operacional quando a sessão foi realizada.
 */

import Appointment from '../../../models/Appointment.js';
import { resolveAndMapAppointmentDTO } from '../../../utils/appointmentDto.js';
import { emitSocket } from '../helpers/socketHelper.js';
import { buildError, checkDoctorPermission } from './_helpers.js';

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'missed'];

export async function execute(id, status, user) {
  if (!VALID_STATUSES.includes(status)) {
    throw buildError('Status clínico inválido', 400, 'INVALID_CLINICAL_STATUS');
  }

  const appointment = await Appointment.findById(id);
  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
  }

  checkDoctorPermission(appointment, user);

  appointment.clinicalStatus = status;
  appointment.history.push({
    action: 'atualização_status_clínico',
    newStatus: status,
    changedBy: user?._id,
    timestamp: new Date(),
    context: 'clínico',
  });

  const updatedAppointment = await appointment.save({ validateBeforeSave: false });

  setImmediate(() => {
    emitSocket('appointment:updated', { appointmentId: updatedAppointment._id, clinicalStatus: status });
  });

  return {
    data: await resolveAndMapAppointmentDTO(updatedAppointment),
    message: 'Status clínico atualizado',
  };
}

export default { execute };
