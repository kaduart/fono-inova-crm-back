// back/services/appointment/commands/completeInsuranceAppointmentCommand.js
/**
 * Insurance Flow Orchestrator
 *
 * Command de domínio responsável por executar o fluxo composto de convênio:
 *   scheduled → confirmed → completed
 *
 * Regras:
 * - É o único lugar onde regra de negócio de convênio pode existir como fluxo composto.
 * - Não contém regra financeira — delega o commit final ao completeSessionService.v2.js.
 * - Usa compare-and-set para transições de estado, garantindo FSM e idempotência.
 */

import mongoose from 'mongoose';
import Appointment from '../../../models/Appointment.js';
import { isInsuranceAppointment } from '../../../utils/appointmentMapper.js';
import { completeSessionV2 } from '../../../services/completeSessionService.v2.js';
import { recordAudit } from '../../../services/auditLogService.js';
import { buildError } from './_helpers.js';

const RECOVERABLE_CANCEL_STATUSES = ['canceled', 'cancelled', 'cancelado', 'processing_cancel'];

function isCancelledStatus(status) {
  return status && RECOVERABLE_CANCEL_STATUSES.includes(status.toLowerCase());
}

function buildHistoryEntry({ action, from, to, actorId }) {
  return {
    action,
    changedBy: actorId || null,
    timestamp: new Date(),
    context: 'operacional',
    details: { from, to },
  };
}

function generateCorrelationId(prefix = 'insurance_flow') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function toActorId(userId) {
  if (!userId) return null;
  if (userId instanceof mongoose.Types.ObjectId) return userId;
  if (mongoose.isValidObjectId(userId)) return new mongoose.Types.ObjectId(userId);
  return null;
}

/**
 * Executa o fluxo composto de convênio.
 *
 * @param {string|ObjectId} appointmentId
 * @param {Object} options
 * @param {string} [options.userId]
 * @param {string} [options.notes]
 * @param {string} [options.evolution]
 * @param {number} [options.sessionValue]
 * @param {string} [options.correlationId]
 * @param {boolean} [options.forceReconfirm]
 * @returns {Promise<{success: boolean, appointmentId: string, transitions: Array, completeResult: Object}>}
 */
export async function execute(appointmentId, options = {}) {
  const {
    userId,
    notes,
    evolution,
    sessionValue,
    forceReconfirm = false,
    correlationId = generateCorrelationId(),
  } = options;

  const actorId = toActorId(userId);

  console.log(`[InsuranceFlowOrchestrator] Iniciando`, {
    appointmentId: appointmentId?.toString?.(),
    correlationId,
    userId,
  });

  const appointment = await Appointment.findById(appointmentId).lean();

  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPT_NOT_FOUND');
  }

  if (!isInsuranceAppointment(appointment)) {
    throw buildError(
      'Orquestrador de convênio não se aplica a este agendamento',
      422,
      'NOT_INSURANCE_APPOINTMENT'
    );
  }

  const beforeSnapshot = { ...appointment };
  const transitions = [];

  // ============================================================
  // IDEMPOTÊNCIA
  // ============================================================
  if (appointment.operationalStatus === 'completed') {
    console.log(`[InsuranceFlowOrchestrator] ✅ Idempotente — já completado (${appointmentId})`);
    return {
      success: true,
      idempotent: true,
      appointmentId: appointmentId.toString(),
      correlationId,
      transitions,
      completeResult: null,
    };
  }

  // ============================================================
  // STATE NORMALIZATION
  // ============================================================
  let currentStatus = appointment.operationalStatus;

  // 1. Canceled → Scheduled (recuperação)
  if (isCancelledStatus(currentStatus)) {
    const reactivated = await Appointment.findOneAndUpdate(
      {
        _id: appointmentId,
        operationalStatus: { $in: RECOVERABLE_CANCEL_STATUSES },
      },
      {
        $set: {
          operationalStatus: 'scheduled',
          clinicalStatus: 'pending',
          updatedAt: new Date(),
          _fromInsuranceOrchestrator: true,
        },
        $push: {
          history: buildHistoryEntry({
            action: 'insurance_flow_reactivate',
            from: currentStatus,
            to: 'scheduled',
            actorId,
          }),
        },
      },
      { new: true }
    );

    if (!reactivated) {
      // Pode ter sido completado ou alterado concorrentemente
      const current = await Appointment.findById(appointmentId).lean();
      if (current?.operationalStatus === 'completed') {
        return {
          success: true,
          idempotent: true,
          appointmentId: appointmentId.toString(),
          correlationId,
          transitions,
          completeResult: null,
        };
      }
      throw buildError(
        'Não foi possível reativar o agendamento cancelado',
        409,
        'REACTIVATION_FAILED'
      );
    }

    transitions.push({ entity: 'Appointment', from: currentStatus, to: 'scheduled', timestamp: new Date() });
    currentStatus = 'scheduled';
    console.log(`[InsuranceFlowOrchestrator] 🔄 Cancelamento revertido: ${appointmentId} → scheduled`);
  }

  // 2. Scheduled → Confirmed
  if (currentStatus === 'scheduled') {
    const confirmed = await Appointment.findOneAndUpdate(
      {
        _id: appointmentId,
        operationalStatus: 'scheduled',
      },
      {
        $set: {
          operationalStatus: 'confirmed',
          clinicalStatus: 'pending',
          updatedAt: new Date(),
          _fromInsuranceOrchestrator: true,
        },
        $push: {
          history: buildHistoryEntry({
            action: 'insurance_flow_confirm',
            from: 'scheduled',
            to: 'confirmed',
            actorId,
          }),
        },
      },
      { new: true }
    );

    if (!confirmed) {
      const current = await Appointment.findById(appointmentId).lean();
      if (current?.operationalStatus === 'completed') {
        return {
          success: true,
          idempotent: true,
          appointmentId: appointmentId.toString(),
          correlationId,
          transitions,
          completeResult: null,
        };
      }
      if (current?.operationalStatus === 'confirmed' && !forceReconfirm) {
        // Já está confirmed por outra chamada concorrente
        currentStatus = 'confirmed';
      } else {
        throw buildError(
          'Não foi possível confirmar o agendamento',
          409,
          'CONFIRM_FAILED'
        );
      }
    } else {
      transitions.push({ entity: 'Appointment', from: 'scheduled', to: 'confirmed', timestamp: new Date() });
      currentStatus = 'confirmed';
      console.log(`[InsuranceFlowOrchestrator] ✅ Confirmado: ${appointmentId} → confirmed`);
    }
  }

  // Estados que não devem chegar aqui
  if (currentStatus !== 'confirmed' && currentStatus !== 'completed') {
    throw buildError(
      `Estado operacional não recuperável para fluxo de convênio: '${currentStatus}'`,
      422,
      'INVALID_STATE'
    );
  }

  // ============================================================
  // DELEGAÇÃO DO COMMIT FINANCEIRO
  // ============================================================
  const completeResult = await completeSessionV2(appointmentId, {
    notes,
    evolution,
    sessionValue,
    userId,
    correlationId,
  });

  transitions.push({ entity: 'Appointment', from: 'confirmed', to: 'completed', timestamp: new Date() });

  const afterAppointment = await Appointment.findById(appointmentId).lean();

  await recordAudit({
    user: userId ? { _id: userId } : null,
    action: 'insurance_appointment_finalized',
    entityType: 'Appointment',
    entityId: appointmentId,
    before: beforeSnapshot,
    after: afterAppointment,
    source: 'completeInsuranceAppointmentCommand',
    correlationId,
    metadata: {
      transitions,
      completeResult: {
        success: completeResult.success,
        billingType: completeResult.billingType,
        paymentId: completeResult.paymentId,
        sessionId: completeResult.sessionId,
      },
    },
  });

  console.log(`[InsuranceFlowOrchestrator] ✅ Fluxo finalizado`, {
    appointmentId: appointmentId?.toString?.(),
    correlationId,
    transitions: transitions.map((t) => `${t.from}→${t.to}`),
  });

  return {
    success: true,
    appointmentId: appointmentId.toString(),
    correlationId,
    transitions,
    completeResult,
  };
}

export default { execute };
