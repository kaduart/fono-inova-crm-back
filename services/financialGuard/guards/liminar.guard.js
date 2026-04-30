// services/financialGuard/guards/liminar.guard.js
// ⚖️ Guard para LiminarContract — debita/restaura crédito judicial

import LiminarContract from '../../../models/LiminarContract.js';
import Appointment from '../../../models/Appointment.js';

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
    throw new Error('LIMINAR_CONTRACT_NOT_FOUND');
  }

  if (contract.status !== 'active') {
    throw new Error(`LIMINAR_CONTRACT_NOT_ACTIVE: status=${contract.status}`);
  }

  if (contract.creditBalance < sessionValue) {
    throw new Error(
      `LIMINAR_NO_CREDIT: Disponível R$${contract.creditBalance}, necessário R$${sessionValue}`
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
    throw new Error('LIMINAR_DEBIT_FAILED: race condition ou saldo insuficiente');
  }

  // Esgotado? Atualiza status
  if (result.creditBalance <= 0) {
    await LiminarContract.findByIdAndUpdate(
      liminarContractId,
      { $set: { status: 'exhausted' } },
      { session }
    );

    // Cancela appointments futuros vinculados ao contrato
    const cancelResult = await Appointment.updateMany(
      {
        liminarContract: liminarContractId,
        operationalStatus: { $in: ['scheduled', 'pending', 'pre_agendado'] }
      },
      {
        $set: {
          operationalStatus: 'canceled',
          clinicalStatus:    'canceled',
          cancellationReason: 'Crédito liminar esgotado',
          updatedAt: new Date()
        }
      },
      { session }
    );

    console.log('[LiminarGuard][EXHAUSTED]', {
      liminarContractId,
      appointmentsCanceled: cancelResult.modifiedCount
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

  const result = await LiminarContract.findByIdAndUpdate(
    liminarContractId,
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
          appointmentId: appointmentId || null,
          createdAt:     new Date()
        }
      },
      $set: { updatedAt: new Date() }
    },
    { session, new: true }
  );

  if (!result) {
    throw new Error('LIMINAR_CONTRACT_NOT_FOUND on reversal');
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
