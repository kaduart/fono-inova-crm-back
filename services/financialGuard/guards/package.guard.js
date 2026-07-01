// services/financialGuard/guards/package.guard.js
// 📦 Guard para regras financeiras de PACOTE

import Package from '../../../models/Package.js';
import Payment from '../../../models/Payment.js';
import Appointment from '../../../models/Appointment.js';
import { executeWithSession as bulkCancelAppointments } from '../../appointment/commands/bulkCancelAppointmentsCommand.js';

/**
 * Package Guard - Regras financeiras de pacotes
 * 
 * Contextos suportados:
 * - CANCEL_APPOINTMENT: Restaura crédito/sessão ao cancelar
 * - COMPLETE_SESSION: Consome crédito/sessão ao completar
 */
export default {
  async handle({ context, payload, session }) {
    // 🔥 CANCEL_APPOINTMENT: Restaura crédito/sessão
    if (context === 'CANCEL_APPOINTMENT') {
      return handleCancelAppointment({ payload, session });
    }
    
    // 🔥 COMPLETE_SESSION: Consome crédito/sessão
    if (context === 'COMPLETE_SESSION') {
      return handleCompleteSession({ payload, session });
    }
    
    return { handled: false, reason: 'CONTEXT_NOT_SUPPORTED' };
  }
};

// ============================================================
// CANCEL_APPOINTMENT: Restaura crédito/sessão
// ============================================================
async function handleCancelAppointment({ payload, session }) {
  const { packageId, appointmentStatus, paymentOrigin, sessionValue = 0, confirmedAbsence, appointmentId } = payload;

  console.log('[FinancialGuard][PACKAGE][CANCEL]', {
    appointmentId: appointmentId || 'unknown',
    packageId,
    appointmentStatus,
    paymentOrigin,
    sessionValue
  });

  // 🛡️ GUARD: Se falta confirmada, não restaura crédito
  if (confirmedAbsence) {
    console.log('[PackageGuard] Falta confirmada - não restaura crédito');
    return { handled: false, reason: 'CONFIRMED_ABSENCE' };
  }

  // 🛡️ GUARD: Só restaura se appointment estava completed
  if (appointmentStatus !== 'completed') {
    return { handled: false, reason: 'APPOINTMENT_NOT_COMPLETED' };
  }

  if (!packageId) {
    return { handled: false, reason: 'NO_PACKAGE_ID' };
  }

  const pkg = await Package.findById(packageId).session(session);
  
  if (!pkg) {
    throw new Error('PACKAGE_NOT_FOUND');
  }

  // Log BEFORE
  const beforeState = {
    sessionsDone: pkg.sessionsDone,
    totalSessions: pkg.totalSessions,
    paidSessions: pkg.paidSessions,
    totalPaid: pkg.totalPaid,
    balance: pkg.balance,
    financialStatus: pkg.financialStatus
  };
  
  console.log('[FinancialGuard][PACKAGE][CANCEL][BEFORE]', beforeState);

  // Prepara update
  const update = {
    $set: { updatedAt: new Date() },
    $inc: {}
  };

  // 1. Decrementa sessionsDone
  if (pkg.sessionsDone > 0) {
    update.$inc.sessionsDone = -1;
  }

  // 2. Se era per-session, estorna financeiro
  const isPerSession = paymentOrigin === 'auto_per_session';
  let amountRefunded = 0;

  if (isPerSession && sessionValue > 0) {
    amountRefunded = Math.min(sessionValue, pkg.totalPaid || 0);

    if (amountRefunded > 0) {
      update.$inc.totalPaid = -amountRefunded;
      update.$inc.paidSessions = -1;

      console.log('[PackageGuard] Estornando per-session', {
        packageId,
        amountRefunded,
        sessionValue
      });
    }
  }

  // ⚠️ LEGADO — LIMINAR NÃO USA MAIS PACKAGE
  // O crédito liminar é gerenciado pelo LiminarContract + LiminarGuard.
  // Package.liminarCreditBalance está congelado.
  // const isLiminar = pkg.type === 'liminar';
  // if (isLiminar && sessionValue > 0) {
  //   update.$inc.liminarCreditBalance = sessionValue;
  // }

  const result = await Package.findOneAndUpdate(
    { 
      _id: packageId,
      sessionsDone: { $gt: 0 }
    },
    update,
    { session, new: true }
  );

  if (!result) {
    console.warn(`[PackageGuard] Pacote ${packageId} não atualizado`);
    return { handled: false, reason: 'NO_SESSIONS_TO_RESTORE' };
  }

  // Recalcula balance
  const newBalance = Math.max(0, result.totalValue - (result.totalPaid || 0));
  const newFinancialStatus = calculateFinancialStatus(result.totalPaid, result.totalValue);

  await Package.findByIdAndUpdate(
    packageId,
    { $set: { balance: newBalance, financialStatus: newFinancialStatus } },
    { session }
  );

  // Log AFTER
  const afterState = {
    sessionsDone: result.sessionsDone,
    paidSessions: result.paidSessions,
    totalPaid: result.totalPaid,
    balance: newBalance,
    financialStatus: newFinancialStatus,
    amountRefunded
  };
  
  console.log('[FinancialGuard][PACKAGE][CANCEL][AFTER]', afterState);
  
  console.log('[PackageGuard] Pacote restaurado', {
    packageId,
    appointmentId: appointmentId || 'unknown',
    delta: {
      sessionsDone: result.sessionsDone - beforeState.sessionsDone,
      paidSessions: (result.paidSessions || 0) - (beforeState.paidSessions || 0),
      totalPaid: (result.totalPaid || 0) - (beforeState.totalPaid || 0),
      balance: newBalance - beforeState.balance
    }
  });

  return {
    handled: true,
    packageId,
    sessionsRestored: 1,
    amountRefunded,
    newBalance,
    financialStatus: newFinancialStatus
  };
}

// ============================================================
// COMPLETE_SESSION: Consome crédito/sessão
// ============================================================
async function handleCompleteSession({ payload, session }) {
  const { packageId, sessionValue = 0, paymentOrigin, appointmentId, billingType } = payload;

  console.log('[FinancialGuard][PACKAGE][COMPLETE]', {
    appointmentId: appointmentId || 'unknown',
    packageId,
    billingType,
    paymentOrigin,
    sessionValue
  });

  if (!packageId) {
    return { handled: false, reason: 'NO_PACKAGE_ID' };
  }

  const pkg = await Package.findById(packageId).session(session);

  if (!pkg) {
    throw new Error('PACKAGE_NOT_FOUND');
  }

  const beforeState = {
    sessionsDone: pkg.sessionsDone,
    totalSessions: pkg.totalSessions,
    paidSessions: pkg.paidSessions,
    totalPaid: pkg.totalPaid,
    balance: pkg.balance,
    financialStatus: pkg.financialStatus,
    liminarCreditBalance: pkg.liminarCreditBalance
  };

  console.log('[FinancialGuard][PACKAGE][COMPLETE][BEFORE]', beforeState);

  if (pkg.sessionsDone >= pkg.totalSessions) {
    throw new Error('PACKAGE_NO_CREDIT_AVAILABLE');
  }

  // ⚠️ LEGADO — LIMINAR NÃO USA MAIS PACKAGE
  // Validação de crédito liminar está no LiminarGuard.
  // Package não deve rejeitar complete por falta de crédito liminar.
  // if (billingType === 'liminar' && sessionValue > 0) {
  //   const creditAtual = pkg.liminarCreditBalance || 0;
  //   if (creditAtual < sessionValue) {
  //     throw new Error(`LIMINAR_NO_CREDITS: ...`);
  //   }
  // }

  // Prepara update principal
  const update = {
    $set: { updatedAt: new Date() },
    $inc: { sessionsDone: 1 }
  };

  // Per-session: incrementa totalPaid
  const isPerSession = paymentOrigin === 'auto_per_session';
  let amountCharged = 0;

  if (isPerSession && sessionValue > 0) {
    amountCharged = sessionValue;
    update.$inc.paidSessions = 1;
    update.$inc.totalPaid = sessionValue;
    console.log('[PackageGuard] Cobrando per-session', { packageId, amountCharged });
  }

  // ⚠️ LEGADO — LIMINAR NÃO USA MAIS PACKAGE
  // Crédito é debitado do LiminarContract, não do Package.
  // if (billingType === 'liminar' && sessionValue > 0) {
  //   update.$inc.liminarCreditBalance = -sessionValue;
  // }

  const result = await Package.findOneAndUpdate(
    {
      _id: packageId,
      $expr: { $lt: ['$sessionsDone', '$totalSessions'] }
    },
    update,
    { session, new: true }
  );

  if (!result) {
    throw new Error('PACKAGE_UPDATE_FAILED');
  }

  // ============================================================
  // GAP 2 — PREPAID: recalcula balance do ledger (Payment)
  // ============================================================
  let newBalance;
  let newFinancialStatus;

  if (billingType === 'prepaid') {
    // Fonte de verdade: Payment ledger (não contagem de sessão)
    const agg = await Payment.aggregate([
      { $match: { package: pkg._id, status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).session(session);
    const totalPaidFromLedger = agg[0]?.total || 0;
    newBalance = Math.max(0, (pkg.totalValue || 0) - totalPaidFromLedger);
    newFinancialStatus = calculateFinancialStatus(totalPaidFromLedger, pkg.totalValue || 0);
    console.log('[PackageGuard][PREPAID] Balance do ledger', {
      packageId, totalPaidFromLedger, newBalance
    });
  } else {
    newBalance = Math.max(0, (result.totalValue || 0) - (result.totalPaid || 0));
    newFinancialStatus = calculateFinancialStatus(result.totalPaid, result.totalValue);
  }

  await Package.findByIdAndUpdate(
    packageId,
    { $set: { balance: newBalance, financialStatus: newFinancialStatus } },
    { session, __fromFinancialGuard: true, __guardContext: 'FINANCIAL' }
  );

  // ============================================================
  // GAP 3 — FINISHED: marca pacote e cancela appointments futuros
  // ============================================================
  const sessionsDoneAfter = result.sessionsDone;
  const isFinished = sessionsDoneAfter >= pkg.totalSessions;

  if (isFinished) {
    await Package.findByIdAndUpdate(
      packageId,
      { $set: { status: 'finished' } },
      { session, __fromFinancialGuard: true, __guardContext: 'FINANCIAL' }
    );

    const appointmentsToCancel = await Appointment.find({
      package: packageId,
      operationalStatus: { $in: ['scheduled', 'pending', 'pre_agendado'] }
    }).session(session).select('_id');

    const cancelResult = await bulkCancelAppointments(
      appointmentsToCancel.map(a => a._id),
      { reason: 'Pacote finalizado - sessões esgotadas' },
      null,
      session
    );

    console.log('[PackageGuard][FINISHED] Pacote finalizado', {
      packageId,
      appointmentsCanceled: cancelResult.canceled
    });
  }

  const afterState = {
    sessionsDone: result.sessionsDone,
    paidSessions: result.paidSessions,
    totalPaid: result.totalPaid,
    balance: newBalance,
    financialStatus: newFinancialStatus,
    amountCharged,
    isFinished
  };

  console.log('[FinancialGuard][PACKAGE][COMPLETE][AFTER]', afterState);

  return {
    handled: true,
    packageId,
    sessionsConsumed: 1,
    sessionsRemaining: pkg.totalSessions - sessionsDoneAfter,
    amountCharged,
    newBalance,
    financialStatus: newFinancialStatus,
    isFinished
  };
}

// ============================================================
// HELPERS
// ============================================================
function calculateFinancialStatus(totalPaid, totalValue) {
  if (totalPaid === 0) return 'unpaid';
  if (totalPaid < totalValue) return 'partially_paid';
  return 'paid';
}
