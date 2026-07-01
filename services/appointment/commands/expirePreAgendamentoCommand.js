// back/services/appointment/commands/expirePreAgendamentoCommand.js
/**
 * Expire Pre-Agendamento Command
 *
 * Responsabilidade: expirar pré-agendamentos (pre_agendado) que não foram
 * convertidos a tempo, movendo-os para 'missed' de forma atômica e auditável.
 *
 * Este command é o ÚNICO local autorizado a executar a transição:
 *   pre_agendado → missed
 *
 * Garantias:
 * - Idempotente: executar 2x para o mesmo appointment retorna o mesmo resultado
 * - Transação atômica (Appointment + Session)
 * - Histórico preservado
 * - Evento de domínio publicado
 */

import mongoose from 'mongoose';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { buildError, assertAppointmentTransition } from './_helpers.js';
import { recordAudit } from '../../auditLogService.js';

const MARGIN_MINUTES = 15;

/**
 * Executa a expiração de um pré-agendamento.
 *
 * @param {string|ObjectId} id - ID do Appointment
 * @param {Object} [options]
 * @param {string} [options.reason] - Motivo da expiração
 * @param {string} [options.correlationId] - ID de correlação para rastreio
 * @param {Object} [options.user] - Usuário/system que disparou (opcional)
 */
export async function execute(id, options = {}) {
  const {
    reason = `Pré-agendamento expirado automaticamente — horário não convertido (margem: ${MARGIN_MINUTES}min)`,
    correlationId = `preag_exp_${Date.now()}`,
    user,
  } = options;

  const appointment = await Appointment.findById(id).lean();
  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
  }

  // Idempotência: se já está em estado terminal de expiração, retorna sem efeito
  if (appointment.operationalStatus === 'missed') {
    return {
      data: appointment,
      expired: false,
      message: 'Pré-agendamento já estava expirado.',
    };
  }

  assertAppointmentTransition(
    appointment.operationalStatus,
    'missed',
    'expirePreAgendamentoCommand'
  );

  const beforeSnapshot = appointment;

  const result = await runTransactionWithRetry(async (session) => {
    const locked = await Appointment.findOne(
      { _id: id, operationalStatus: 'pre_agendado' },
      null,
      { session }
    );

    if (!locked) {
      // Já foi processado por outra instância durante a transação
      return null;
    }

    const updated = await Appointment.findByIdAndUpdate(
      id,
      {
        $set: {
          operationalStatus: 'missed',
          clinicalStatus: 'missed',
          updatedAt: new Date(),
        },
        $push: {
          history: {
            action: 'auto_expired',
            previousStatus: locked.operationalStatus,
            newStatus: 'missed',
            changedBy: user?._id,
            timestamp: new Date(),
            context: 'operacional',
            details: { reason, correlationId },
          },
        },
      },
      { new: true, session }
    );

    if (locked.session) {
      await Session.findByIdAndUpdate(
        locked.session,
        {
          $set: {
            status: 'missed',
            updatedAt: new Date(),
          },
          $push: {
            history: {
              action: 'auto_expired',
              newStatus: 'missed',
              timestamp: new Date(),
              context: 'Session vinculada a pré-agendamento expirado',
              correlationId,
            },
          },
        },
        { session }
      );
    }

    return updated;
  });

  if (!result) {
    return {
      data: await Appointment.findById(id).lean(),
      expired: false,
      message: 'Pré-agendamento já foi processado por outra instância.',
    };
  }

  await publishEvent(EventTypes.APPOINTMENT_STATUS_CHANGED, {
    appointmentId: result._id,
    patientId: result.patient,
    doctorId: result.doctor,
    previousStatus: beforeSnapshot.operationalStatus,
    newStatus: 'missed',
    reason: 'auto_expired',
    correlationId,
  });

  await recordAudit({
    user,
    action: 'appointment_expired',
    entityType: 'Appointment',
    entityId: result._id,
    before: beforeSnapshot,
    after: result,
    source: 'appointment_command:expirePreAgendamentoCommand',
    correlationId,
    metadata: { reason },
  });

  return {
    data: result,
    expired: true,
    message: 'Pré-agendamento expirado com sucesso.',
  };
}

export default { execute };
