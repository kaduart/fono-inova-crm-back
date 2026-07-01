// back/services/appointment/commands/postAppointmentCommand.js
/**
 * Post Appointment Command
 *
 * Responsabilidade: registrar o envio de mensagem pós-atendimento
 * (mensagem de agradecimento ou solicitação de avaliação).
 */

import Appointment from '../../../models/Appointment.js';
import { buildError } from './_helpers.js';
import { recordAudit } from '../../auditLogService.js';

export async function execute(id, step) {
  const field = step === 'msg2' ? 'reviewRequestSentAt' : 'postAppointmentSentAt';
  const beforeAppointment = await Appointment.findById(id).lean();
  const appointment = await Appointment.findByIdAndUpdate(
    id,
    { [field]: new Date() },
    { new: true, select: `${field}` }
  );

  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
  }

  await recordAudit({
    user: null,
    action: 'appointment_post_message_sent',
    entityType: 'Appointment',
    entityId: appointment._id,
    before: beforeAppointment,
    after: appointment,
    source: 'appointment_command:postAppointmentCommand',
    correlationId: appointment.correlationId,
    metadata: { step, field },
  });

  return {
    data: { [field]: appointment[field] },
    message: 'Envio registrado',
  };
}

export default { execute };
