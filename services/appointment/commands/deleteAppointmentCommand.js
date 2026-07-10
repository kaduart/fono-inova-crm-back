// back/services/appointment/commands/deleteAppointmentCommand.js
/**
 * Delete Appointment Command
 *
 * Responsabilidade: deletar um agendamento isolado (sem pacote)
 * e garantir que referências em Session, Payment e Patient sejam limpas.
 *
 * 🔒 Regras:
 * - Só pode deletar appointments SEM pacote
 * - Appointment, Payment e referências em Patient devem ser atualizados atomically
 * - Session não é deletada, mas tem appointmentId removido
 */

import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import Payment from '../../../models/Payment.js';
import Patient from '../../../models/Patient.js';
import { updatePatientAppointments } from '../../../utils/appointmentUpdater.js';
import { emitSocket } from '../helpers/socketHelper.js';
import { buildError } from './_helpers.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';
import { EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { recordAudit } from '../../auditLogService.js';

export async function execute(id, user) {
  const appointment = await Appointment.findById(id).populate('session payment');

  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
  }

  if (appointment.package) {
    throw buildError(
      'Não é possível excluir agendamentos vinculados a pacotes. Use CANCELAR para manter integridade financeira.',
      400,
      'PACKAGE_APPOINTMENT_DELETE_BLOCKED'
    );
  }

  const { patient, session, payment } = appointment;
  const beforeSnapshot = appointment.toObject({ virtuals: false, getters: false });

  await runTransactionWithRetry(async (mongoSession) => {
    // 1. Remove referência do appointment na Session
    if (session) {
      await Session.findByIdAndUpdate(
        session._id,
        { $unset: { appointmentId: 1 }, updatedAt: new Date() },
        { session: mongoSession }
      );
    }

    // 2. Deleta Payment associado (se existir e não for de pacote)
    if (payment && payment.kind !== 'package_receipt') {
      await Payment.findByIdAndDelete(payment._id, { session: mongoSession });
    }

    // 3. Remove appointment do array do paciente
    if (patient) {
      await Patient.findByIdAndUpdate(
        patient,
        { $pull: { appointments: appointment._id } },
        { session: mongoSession }
      );
    }

    // 4. Deleta o appointment
    await Appointment.findByIdAndDelete(appointment._id, { session: mongoSession });

    // 5. Registra evento de domínio no Outbox
    await saveToOutbox({
      eventType: EventTypes.APPOINTMENT_DELETED,
      aggregateType: 'appointment',
      aggregateId: appointment._id.toString(),
      payload: {
        appointmentId: appointment._id.toString(),
        patientId: patient?._id?.toString() || patient?.toString() || null,
        doctorId: appointment.doctor?._id?.toString() || appointment.doctor?.toString() || null,
        sessionId: session?._id?.toString() || null,
        paymentId: payment?._id?.toString() || null,
      },
      correlationId: `appt_del_${appointment._id}_${Date.now()}`
    }, mongoSession);
  });

  // Side effects pós-transação
  try {
    await emitSocket('appointmentDeleted', {
      _id: appointment._id,
      patient,
      doctor: appointment.doctor,
      date: appointment.date,
      time: appointment.time,
      source: 'crm_delete',
    });
  } catch (socketErr) {
    console.error('[deleteAppointmentCommand] Erro ao emitir socket:', socketErr.message);
  }

  await updatePatientAppointments(patient);

  await recordAudit({
    user,
    action: 'appointment_deleted',
    entityType: 'Appointment',
    entityId: appointment._id,
    before: beforeSnapshot,
    after: null,
    source: 'appointment_command:deleteAppointmentCommand',
    correlationId: appointment.correlationId,
  });

  return {
    data: { deletedId: id },
    message: 'Agendamento deletado com sucesso',
  };
}

export default { execute };
