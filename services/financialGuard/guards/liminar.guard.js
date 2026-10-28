// services/financialGuard/guards/liminar.guard.js
// ⚖️ Guard para LiminarContract — debita/restaura crédito judicial

import LiminarContract from '../../../models/LiminarContract.js';
import Appointment from '../../../models/Appointment.js';
import { executeWithSession as cancelAppointmentWithSession } from '../../appointment/commands/cancelAppointmentCommand.js';
import { AppError } from '../../../errors/AppError.js';

export default {
  async handle({ context, payload, session }) {
    if (context === 'CANCEL_APPOINTMENT') {
      return handleCancel({ payload, session });
    }
    if (context === 'COMPLETE_SESSION') {
      return handleComplete({ payload, session });
    }
    return { handled: false, reason: 'CONTEXT_NOT_SUPPORTED' };
  }
};

// ──────────────────────────────────────────────────────────────
// COMPLETE_SESSION — debita crédito
// ──────────────────────────────────────────────────────────────
async function handleComplete({ payload, session }) {
  const { liminarContractId, sessionValue = 0, appointmentId } = payload;

  console.log('[LiminarGuard][COMPLETE]', { liminarContractId, sessionValue, appointmentId });

  if (!liminarContractId) {
    return { handled: false, reason: 'NO_LIMINAR_CONTRACT_ID' };
  }

  const contract = await LiminarContract.findById(liminarContractId).session(session);

  if (!contract) {
    throw new AppError('LIMINAR_CONTRACT_NOT_FOUND', 'Contrato de liminar não encontrado', { status: 404 });
  }

  if (contract.status !== 'active') {
    throw new AppError('LIMINAR_CONTRACT_NOT_ACTIVE', `Contrato de liminar não está ativo (status atual: ${contract.status})`, { status: 409, details: { contractStatus: contract.status } });
  }

  if (contract.creditBalance < sessionValue) {
    throw new Error(
      new AppError('LIMINAR_NO_CREDIT', `Crédito insuficiente no contrato de liminar: disponível R$${contract.creditBalance}, necessário R$${sessionValue}`, { status: 422, details: { creditBalance: contract.creditBalance, sessionValue } })
    );
  }

  const before = { creditBalance: contract.creditBalance, usedCredit: contract.usedCredit };

  const result = await LiminarContract.findOneAndUpdate(
    {
      _id: liminarContractId,
      creditBalance: { $gte: sessionValue },
      status: 'active'
    },
    {
      $inc: {
        creditBalance: -sessionValue,
        usedCredit:    +sessionValue
      },
      $push: {
        creditHistory: {
          amount:        sessionValue,
          type:          'debit',
          reason:        'session_completed',
          appointmentId: appointmentId || null,
          createdAt:     new Date()
        }
      },
      $set: { updatedAt: new Date() }
    },
    { session, new: true }
  );

  if (!result) {
    throw new AppError('LIMINAR_DEBIT_FAILED', 'Falha ao debitar crédito da liminar (condição de corrida ou saldo insuficiente)', { status: 409 });
  }

  // Esgotado? Atualiza status
  if (result.creditBalance <= 0) {
    await LiminarContract.findByIdAndUpdate(
      liminarContractId,
      { $set: { status: 'exhausted' } },
      { session }
    );

    // Cancela appointments futuros vinculados ao contrato via command
    const appointmentsToCancel = await Appointment.find({
      liminarContract: liminarContractId,
      operationalStatus: { $in: ['scheduled', 'pending', 'pre_agendado'] }
    }).session(session).select('_id');

    let canceledCount = 0;
    for (const appt of appointmentsToCancel) {
      try {
        await cancelAppointmentWithSession(
          appt._id,
          { reason: 'Crédito liminar esgotado' },
          null,
          session
        );
        canceledCount++;
      } catch (err) {
        console.error('[LiminarGuard][EXHAUSTED] Erro ao cancelar appointment', appt._id, err.message);
      }
    }

    console.log('[LiminarGuard][EXHAUSTED]', {
      liminarContractId,
      appointmentsCanceled: canceledCount
    });
  }

  console.log('[LiminarGuard][COMPLETE][OK]', {
    liminarContractId,
    before,
    after: { creditBalance: result.creditBalance, usedCredit: result.usedCredit }
  });

  return {
    handled: true,
    liminarContractId,
    sessionValue,
    creditBalance:  result.creditBalance,
    usedCredit:     result.usedCredit,
    isExhausted:    result.creditBalance <= 0
  };
}

// ──────────────────────────────────────────────────────────────
// CANCEL_APPOINTMENT — restaura crédito (reversal)
// ──────────────────────────────────────────────────────────────
async function handleCancel({ payload, session }) {
  const { liminarContractId, sessionValue = 0, appointmentStatus, confirmedAbsence, appointmentId } = payload;

  console.log('[LiminarGuard][CANCEL]', { liminarContractId, sessionValue, appointmentStatus });

  if (confirmedAbsence) {
    return { handled: false, reason: 'CONFIRMED_ABSENCE' };
  }

  if (appointmentStatus !== 'completed') {
    return { handled: false, reason: 'APPOINTMENT_NOT_COMPLETED' };
  }

  if (!liminarContractId || sessionValue <= 0) {
    return { handled: false, reason: 'NO_CONTRACT_OR_VALUE' };
  }

  const reversalKey = appointmentId || null;
  const result = await LiminarContract.findOneAndUpdate(
    {
      _id: liminarContractId,
      usedCredit: { $gte: sessionValue },
      creditHistory: {
        $not: {
          $elemMatch: {
            type: 'reversal',
            reason: 'appointment_canceled',
            appointmentId: reversalKey,
          },
        },
      },
    },
    {
      $inc: {
        creditBalance: +sessionValue,
        usedCredit:    -sessionValue
      },
      $push: {
        creditHistory: {
          amount:        sessionValue,
          type:          'reversal',
          reason:        'appointment_canceled',
          appointmentId: reversalKey,
          createdAt:     new Date()
        }
      },
      $set: { updatedAt: new Date() }
    },
    { session, new: true }
  );

  if (!result) {
    const current = await LiminarContract.findById(liminarContractId).session(session).lean();
    if (!current) throw new AppError('LIMINAR_CONTRACT_NOT_FOUND', 'Contrato de liminar não encontrado (reversão)', { status: 404 });
    const alreadyReversed = current.creditHistory?.some(item =>
      item.type === 'reversal'
      && item.reason === 'appointment_canceled'
      && String(item.appointmentId || '') === String(reversalKey || ''));
    if (alreadyReversed) {
      return {
        handled: true,
        idempotent: true,
        liminarContractId,
        amountRefunded: 0,
        creditBalance: current.creditBalance,
      };
    }
    throw new AppError('LIMINAR_REVERSAL_CREDIT_INCONSISTENT', 'Inconsistência de crédito ao reverter a liminar', { status: 409 });
  }

  // Reativa se estava exhausted e agora tem crédito
  if (result.status === 'exhausted' && result.creditBalance > 0) {
    await LiminarContract.findByIdAndUpdate(
      liminarContractId,
      { $set: { status: 'active' } },
      { session }
    );
  }

  console.log('[LiminarGuard][CANCEL][OK]', {
    liminarContractId,
    restored: sessionValue,
    newBalance: result.creditBalance
  });

  return {
    handled: true,
    liminarContractId,
    amountRefunded: sessionValue,
    creditBalance:  result.creditBalance
  };
}
