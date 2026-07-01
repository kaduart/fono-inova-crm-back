// back/services/appointment/commands/clinicalStatusCommand.js
/**
 * Clinical Status Command
 *
 * Responsabilidade: atualizar o status clínico de um agendamento.
 * O status clínico é descritivo e NUNCA deve afetar o status operacional
 * nem ser usado como proxy de finalização de atendimento.
 */

import Appointment from '../../../models/Appointment.js';
import { resolveAndMapAppointmentDTO } from '../../../utils/appointmentDto.js';
import { emitSocket } from '../helpers/socketHelper.js';
import { buildError, checkDoctorPermission } from './_helpers.js';
import { recordAudit } from '../../auditLogService.js';

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'missed'];

export async function execute(id, status, user) {
  if (!VALID_STATUSES.includes(status)) {
    throw buildError('Status clínico inválido', 400, 'INVALID_CLINICAL_STATUS');
  }

  const appointment = await Appointment.findById(id);
  const beforeSnapshot = appointment ? appointment.toObject({ virtuals: false, getters: false }) : null;

  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
  }

  checkDoctorPermission(appointment, user);

  // 🛡️ GUARDA DE DOMÍNIO: clinicalStatus='completed' só é permitido
  // se o atendimento já foi finalizado operacionalmente via completeSessionV2.
  // Isso evita o estado inconsistente: clinical completed + operational confirmed/scheduled.
  if (status === 'completed' && appointment.operationalStatus !== 'completed') {
    throw buildError(
      'Transição inválida: finalização clínica requer finalização operacional via completeSessionV2',
      409,
      'CLINICAL_COMPLETION_REQUIRES_OPERATIONAL_COMPLETION'
    );
  }

  appointment.clinicalStatus = status;
  appointment.history.push({
    action: 'atualização_status_clínico',
    newStatus: status,
    changedBy: user?._id,
    timestamp: new Date(),
    context: 'clínico',
  });

  const updatedAppointment = await appointment.save({ validateBeforeSave: false });

  await recordAudit({
    user,
    action: 'appointment_clinical_status_updated',
    entityType: 'Appointment',
    entityId: updatedAppointment._id,
    before: beforeSnapshot,
    after: updatedAppointment,
    source: 'appointment_command:clinicalStatusCommand',
    correlationId: updatedAppointment.correlationId,
    metadata: { clinicalStatus: status },
  });

  setImmediate(() => {
    emitSocket('appointment:updated', { appointmentId: updatedAppointment._id, clinicalStatus: status });
  });

  return {
    data: await resolveAndMapAppointmentDTO(updatedAppointment),
    message: 'Status clínico atualizado',
  };
}

export default { execute };
