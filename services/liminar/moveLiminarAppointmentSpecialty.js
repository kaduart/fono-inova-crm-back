// back/services/liminar/moveLiminarAppointmentSpecialty.js
/**
 * Move um Appointment liminar de uma especialidade para outra dentro do mesmo
 * contrato e plano terapêutico ativo.
 *
 * Caso de uso: sessão foi agendada/gerada na especialidade errada (ex: psicologia
 * em vez de psicopedagogia) e precisa ser corrigida sem perder o vínculo com o
 * contrato liminar e o crédito já consumido.
 *
 * Regras:
 * - Mantém o mesmo LiminarContract e TherapeuticPlan.
 * - Atualiza specialty, sessionType, doctor e sessionValue de acordo com a configuração
 *   da especialidade destino no plano terapêutico.
 * - Se a sessão já foi completada e o valor mudou, reverte o débito anterior e
 *   debita o novo valor do contrato (mantém creditHistory auditável).
 * - Se a sessão não foi completada, apenas ajusta metadados.
 * - Valida limites de totalSessions por especialidade no plano.
 * - Nunca deixa creditBalance negativo.
 */

import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import LiminarContract from '../../models/LiminarContract.js';
import TherapeuticPlan from '../../models/TherapeuticPlan.js';
import { safeAbortTransaction } from '../../utils/safeAbortTransaction.js';

function normalizeSpecialty(v) {
  if (!v) return v;
  return String(v).toLowerCase().trim().replace(/\s+/g, '_');
}

function therapyMapToObject(map) {
  if (!map) return {};
  if (map instanceof Map) return Object.fromEntries(map);
  return map;
}

/**
 * @param {Object} params
 * @param {string} params.appointmentId
 * @param {string} params.targetSpecialty
 * @param {string} [params.reason]
 * @param {string} [params.userId]
 * @returns {Promise<Object>}
 */
export async function moveLiminarAppointmentSpecialty({ appointmentId, targetSpecialty, reason, userId }) {
  const mongoSession = await mongoose.startSession();

  try {
    mongoSession.startTransaction();

    const appointment = await Appointment.findById(appointmentId).session(mongoSession);
    if (!appointment) {
      const err = new Error('Agendamento não encontrado');
      err.code = 'APPOINTMENT_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    if (appointment.billingType !== 'liminar' || !appointment.liminarContract) {
      const err = new Error('Apenas agendamentos de liminar podem ser movidos entre especialidades');
      err.code = 'NOT_LIMINAR_APPOINTMENT';
      err.statusCode = 422;
      throw err;
    }

    const targetSpecialtyNorm = normalizeSpecialty(targetSpecialty);
    const currentSpecialtyNorm = normalizeSpecialty(appointment.specialty);

    if (targetSpecialtyNorm === currentSpecialtyNorm) {
      const err = new Error('A especialidade destino é igual à atual');
      err.code = 'SAME_SPECIALTY';
      err.statusCode = 422;
      throw err;
    }

    const [contract, plan] = await Promise.all([
      LiminarContract.findById(appointment.liminarContract).session(mongoSession),
      TherapeuticPlan.findOne({
        liminarContract: appointment.liminarContract,
        status: 'active',
      }).session(mongoSession),
    ]);

    if (!contract) {
      const err = new Error('Contrato liminar não encontrado');
      err.code = 'LIMINAR_CONTRACT_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    if (!plan) {
      const err = new Error('Plano terapêutico ativo não encontrado');
      err.code = 'THERAPEUTIC_PLAN_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    const therapies = therapyMapToObject(plan.therapies);
    const targetConfig = therapies[targetSpecialtyNorm];

    if (!targetConfig) {
      const err = new Error(`Especialidade "${targetSpecialty}" não está configurada no plano terapêutico`);
      err.code = 'SPECIALTY_NOT_IN_PLAN';
      err.statusCode = 422;
      throw err;
    }

    // Nota: não bloqueamos por totalSessions da especialidade destino porque a
    // base já pode conter sessões além do limite configurado (geração manual,
    // ajustes anteriores, etc.). A movimentação é uma correção administrativa.

    const oldValue = appointment.sessionValue || 0;
    const newValue = targetConfig.sessionValue || 0;
    const newDoctor = targetConfig.doctor || appointment.doctor;

    // 1. Ajuste financeiro quando a sessão já foi completada
    if (appointment.operationalStatus === 'completed' && oldValue !== newValue) {
      const delta = newValue - oldValue;

      if (contract.creditBalance < delta) {
        const err = new Error(
          `Saldo liminar insuficiente para ajuste: disponível R$${contract.creditBalance}, necessário R$${delta}`
        );
        err.code = 'LIMINAR_INSUFFICIENT_CREDIT';
        err.statusCode = 422;
        throw err;
      }

      const updateResult = await LiminarContract.findOneAndUpdate(
        {
          _id: contract._id,
          creditBalance: { $gte: delta },
        },
        {
          $inc: { creditBalance: -delta, usedCredit: +delta },
          $push: {
            creditHistory: {
              $each: [
                {
                  amount: oldValue,
                  type: 'reversal',
                  reason: 'liminar_specialty_moved',
                  appointmentId: appointment._id,
                  createdAt: new Date(),
                  createdBy: userId || null,
                },
                {
                  amount: newValue,
                  type: 'debit',
                  reason: 'liminar_specialty_moved',
                  appointmentId: appointment._id,
                  createdAt: new Date(),
                  createdBy: userId || null,
                },
              ],
            },
          },
          $set: { updatedAt: new Date() },
        },
        { session: mongoSession, new: true }
      );

      if (!updateResult) {
        const err = new Error('Ajuste de crédito falhou: saldo insuficiente ou condição de corrida');
        err.code = 'LIMINAR_CREDIT_ADJUSTMENT_FAILED';
        err.statusCode = 422;
        throw err;
      }

      // Reativa contrato se estava exhausted e agora tem saldo
      if (updateResult.status === 'exhausted' && updateResult.creditBalance > 0) {
        await LiminarContract.findByIdAndUpdate(
          contract._id,
          { $set: { status: 'active' } },
          { session: mongoSession }
        );
      }
    }

    // 2. Atualiza Appointment
    appointment.specialty = targetSpecialtyNorm;
    appointment.sessionType = targetSpecialtyNorm;
    appointment.doctor = newDoctor;
    appointment.sessionValue = newValue;
    appointment.history = appointment.history || [];
    appointment.history.push({
      action: 'liminar_specialty_moved',
      newStatus: appointment.operationalStatus,
      changedBy: userId || null,
      timestamp: new Date(),
      context: `${currentSpecialtyNorm} → ${targetSpecialtyNorm}${reason ? `: ${reason}` : ''}`,
    });
    await appointment.save({ session: mongoSession });

    // 3. Atualiza Session vinculada
    if (appointment.session) {
      await Session.findByIdAndUpdate(
        appointment.session,
        {
          $set: {
            sessionType: targetSpecialtyNorm.replace(/_/g, ' '),
            doctor: newDoctor,
            sessionValue: newValue,
          },
        },
        { session: mongoSession }
      );
    }

    // 4. Atualiza Payment vinculado (amount e sessionType, se houver)
    if (appointment.payment) {
      await Payment.findByIdAndUpdate(
        appointment.payment,
        {
          $set: {
            amount: newValue,
            sessionType: targetSpecialtyNorm,
          },
        },
        { session: mongoSession }
      );
    }

    await mongoSession.commitTransaction();

    return {
      appointmentId: appointment._id.toString(),
      fromSpecialty: currentSpecialtyNorm,
      toSpecialty: targetSpecialtyNorm,
      sessionValue: { old: oldValue, new: newValue },
      doctorId: newDoctor?.toString?.() || newDoctor,
    };
  } catch (error) {
    await safeAbortTransaction(mongoSession);
    throw error;
  } finally {
    mongoSession.endSession();
  }
}

export default moveLiminarAppointmentSpecialty;
