// back/services/appointment/commands/rescheduleAppointmentCommand.js
/**
 * Reschedule Appointment Command
 *
 * Remarcação rápida (botão "Mudar data" / arrastar no calendário). Só valida
 * a regra específica de remarcação (appointmentReschedulePolicy) e DELEGA a
 * escrita ao updateAppointmentCommand — única regra de domínio para
 * Appointment + Session + Payment + Pacote + outbox + socket + auditoria.
 * Não duplicar aqui nenhuma lógica de sincronização.
 */
import Appointment from '../../../models/Appointment.js';
import InsuranceGuide from '../../../models/InsuranceGuide.js';
import LiminarContract from '../../../models/LiminarContract.js';
import { execute as updateAppointmentExecute } from './updateAppointmentCommand.js';
import { buildError, checkDoctorPermission, toObjectIdString } from './_helpers.js';
import { assertRescheduleAllowed, isCanceledForReschedule } from '../policies/appointmentReschedulePolicy.js';

export async function execute(id, { date, time, reason } = {}, user) {
  if (!id) {
    throw buildError('ID do agendamento é obrigatório', 400, 'MISSING_ID');
  }

  const appointment = await Appointment.findById(id)
    .select('operationalStatus date time doctor patient billingType insuranceGuide liminarContract')
    .lean();

  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
  }

  checkDoctorPermission(appointment, user);

  const guideId = toObjectIdString(appointment.insuranceGuide);
  const liminarId = toObjectIdString(appointment.liminarContract);
  const [guide, liminar] = await Promise.all([
    guideId ? InsuranceGuide.findById(guideId).select('number status expiresAt').lean() : null,
    liminarId ? LiminarContract.findById(liminarId).select('expirationDate').lean() : null,
  ]);

  const target = assertRescheduleAllowed({
    appointment,
    guide,
    liminar,
    newDate: date,
    newTime: time,
  });

  // Cancelado: reaproveita o agendamento. Voltar para 'scheduled' no mesmo update aciona o
  // bloco de reativação do updateAppointmentCommand (restoreCanceledAppointmentCommand:
  // Session → scheduled, pacote/Payment restaurados — Payment volta 'pending', nunca 'paid').
  const reactivating = isCanceledForReschedule(appointment.operationalStatus);

  const result = await updateAppointmentExecute(
    id,
    {
      date: target.date,
      time: target.time,
      doctorId: toObjectIdString(appointment.doctor),
      rescheduleReason: reason || (reactivating ? 'Reativado e remarcado via calendário' : 'Remarcação via calendário'),
      rescheduledAt: new Date(),
      ...(reactivating
        ? { operationalStatus: 'scheduled', canceledAt: null, cancelReason: '' }
        : {}),
    },
    user
  );

  return {
    data: result.data,
    reactivated: reactivating,
    message: reactivating ? 'Agendamento reativado e remarcado com sucesso' : 'Agendamento remarcado com sucesso',
  };
}

export default { execute };
