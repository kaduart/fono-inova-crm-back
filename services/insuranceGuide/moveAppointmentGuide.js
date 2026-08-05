// back/services/insuranceGuide/moveAppointmentGuide.js
/**
 * Move um Appointment (e sua Session/Payment vinculados) de uma InsuranceGuide
 * para outra, ajustando os contadores das duas guias de forma transacional.
 *
 * Contexto: guias de convênio são criadas errado, trocadas, ou uma sessão é
 * lançada na guia errada por engano. Não existia nenhum caminho (UI ou API)
 * pra corrigir isso sem editar usedSessions manualmente no banco — o que já
 * causou divergências no passado (ver back/docs/convenio-guide-consumption-audit/).
 *
 * Reaproveita exatamente a mesma lógica já validada em produção:
 * - Consumo: InsuranceGuide.consumeSession() (mesmo método usado no complete
 *   de convênio, ver services/completeSession/handlers/convenioHandler.js)
 * - Liberação: decremento + reativação exhausted->active + limpeza de
 *   consumptionHistory (mesmo padrão usado no cancelamento de billing de
 *   convênio, ver domains/billing/services/insuranceBillingService.v2.js)
 */

import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import { GuideLifecycleService } from '../guideLifecycle/GuideLifecycleService.js';
import { safeAbortTransaction } from '../../utils/safeAbortTransaction.js';

/**
 * Valida se o appointment pode ser movido para a guia destino.
 * Não faz nenhuma escrita — só checagens.
 *
 * @returns {Promise<string[]>} lista de códigos de erro (vazia = ok pra mover)
 */
async function validateMove({ appointment, fromGuide, targetGuide }) {
  const errors = [];

  if (String(fromGuide._id) === String(targetGuide._id)) {
    errors.push('SAME_GUIDE');
    return errors; // demais checagens não fazem sentido nesse caso
  }

  if (String(appointment.patient) !== String(targetGuide.patientId)) {
    errors.push('PATIENT_MISMATCH');
  }

  const apptSpecialty = (appointment.specialty || '').toLowerCase().trim();
  const guideSpecialty = (targetGuide.specialty || '').toLowerCase().trim();
  if (apptSpecialty && guideSpecialty && apptSpecialty !== guideSpecialty) {
    errors.push('SPECIALTY_MISMATCH');
  }

  const apptInsurance = (appointment.insuranceProvider || '').toLowerCase().trim();
  const guideInsurance = (targetGuide.insurance || '').toLowerCase().trim();
  if (apptInsurance && guideInsurance && apptInsurance !== guideInsurance) {
    errors.push('INSURANCE_MISMATCH');
  }

  const lifecycle = await GuideLifecycleService.evaluate(targetGuide, new Date());
  if (!lifecycle.eligibility.canBill) {
    errors.push('TARGET_GUIDE_NOT_BILLABLE');
  }

  if (targetGuide.usedSessions >= targetGuide.totalSessions) {
    errors.push('TARGET_GUIDE_EXHAUSTED');
  }

  const apptDate = new Date(appointment.date);
  if (targetGuide.issuedAt && apptDate < new Date(targetGuide.issuedAt)) {
    errors.push('APPOINTMENT_BEFORE_GUIDE_WINDOW');
  }
  if (targetGuide.expiresAt && apptDate > new Date(targetGuide.expiresAt)) {
    errors.push('APPOINTMENT_AFTER_GUIDE_WINDOW');
  }

  return errors;
}

/**
 * Move um appointment de uma guia pra outra, recalculando usedSessions/status
 * das duas guias dentro de uma transação. Não incrementa/decrementa às cegas:
 * reusa os mesmos métodos/regras que o fluxo normal de completar/cancelar usa.
 *
 * @param {Object} params
 * @param {string} params.appointmentId
 * @param {string} params.targetGuideId
 * @param {string} [params.reason]
 * @param {string} [params.userId] - quem está executando a correção (audit trail)
 * @param {boolean} [params.force] - ignora as validações de negócio (SPECIALTY_MISMATCH etc,
 *   mas NUNCA ignora TARGET_GUIDE_EXHAUSTED — isso é bloqueado pelo próprio schema)
 * @returns {Promise<Object>} resumo com o estado final das duas guias
 */
export async function moveAppointmentGuide({ appointmentId, targetGuideId, reason, userId, force = false }) {
  const mongoSession = await mongoose.startSession();

  try {
    mongoSession.startTransaction();

    const appointment = await Appointment.findById(appointmentId).session(mongoSession);
    if (!appointment) {
      const err = new Error('Appointment não encontrado');
      err.code = 'APPOINTMENT_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    if (!appointment.insuranceGuide) {
      const err = new Error('Appointment não está vinculado a nenhuma guia de convênio');
      err.code = 'APPOINTMENT_HAS_NO_GUIDE';
      err.statusCode = 422;
      throw err;
    }

    const [fromGuide, targetGuide] = await Promise.all([
      InsuranceGuide.findById(appointment.insuranceGuide).session(mongoSession),
      InsuranceGuide.findById(targetGuideId).session(mongoSession),
    ]);

    if (!fromGuide) {
      const err = new Error('Guia de origem não encontrada');
      err.code = 'FROM_GUIDE_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }
    if (!targetGuide) {
      const err = new Error('Guia de destino não encontrada');
      err.code = 'TARGET_GUIDE_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    const validationErrors = await validateMove({ appointment, fromGuide, targetGuide });
    // TARGET_GUIDE_EXHAUSTED nunca é ignorável via force — o guard de negócio
    // (consumeSession) vai barrar de qualquer forma, então falha aqui é só
    // uma mensagem mais clara e mais cedo, sem ter aberto a transação à toa.
    const blockingErrors = force
      ? validationErrors.filter((e) => e === 'TARGET_GUIDE_EXHAUSTED' || e === 'SAME_GUIDE')
      : validationErrors;

    if (blockingErrors.length > 0) {
      const err = new Error(`Movimentação bloqueada: ${blockingErrors.join(', ')}`);
      err.code = 'MOVE_VALIDATION_FAILED';
      err.statusCode = 422;
      err.details = validationErrors;
      throw err;
    }

    const sessionDoc = appointment.session
      ? await Session.findById(appointment.session).session(mongoSession)
      : null;

    // 1. Libera na guia de origem — mesmo padrão do cancelamento de billing
    //    de convênio (insuranceBillingService.v2.js): decrementa, reativa se
    //    estava exhausted (verificando validade), remove entrada correspondente
    //    do consumptionHistory pra não deixar auditoria órfã apontando pra sessão
    //    que não é mais dela.
    if (fromGuide.usedSessions > 0) {
      fromGuide.usedSessions -= 1;

      if (fromGuide.status === 'exhausted' && fromGuide.usedSessions < fromGuide.totalSessions) {
        const now = new Date();
        if (!fromGuide.expiresAt || fromGuide.expiresAt >= now) {
          fromGuide.status = 'active';
        }
      }

      const sessionIdStr = sessionDoc?._id?.toString();
      if (sessionIdStr) {
        fromGuide.consumptionHistory = (fromGuide.consumptionHistory || []).filter(
          (h) => h.sessionId?.toString() !== sessionIdStr
        );
      }

      await fromGuide.save({ session: mongoSession });
    }

    // 2. Consome na guia destino — mesmo método usado no complete de convênio
    //    (valida status/capacidade/validade, incrementa, auto-transiciona pra
    //    exhausted se necessário, registra consumptionHistory).
    await targetGuide.consumeSession(mongoSession, {
      sessionId: sessionDoc?._id,
      professionalId: appointment.doctor,
      notes: reason || 'Movido manualmente entre guias (correção administrativa)',
    });

    // 3. Atualiza a trinca Appointment / Session / Payment
    appointment.insuranceGuide = targetGuide._id;
    appointment.history = appointment.history || [];
    appointment.history.push({
      action: 'insurance_guide_moved',
      newStatus: appointment.operationalStatus,
      changedBy: userId || null,
      timestamp: new Date(),
      context: `Guia ${fromGuide.number} → ${targetGuide.number}${reason ? `: ${reason}` : ''}`,
    });
    await appointment.save({ session: mongoSession });

    if (sessionDoc) {
      sessionDoc.insuranceGuide = targetGuide._id;
      await sessionDoc.save({ session: mongoSession });
    }

    if (appointment.payment) {
      await Payment.findByIdAndUpdate(
        appointment.payment,
        { $set: { insuranceGuide: targetGuide._id } },
        { session: mongoSession }
      );
    }

    await mongoSession.commitTransaction();

    return {
      appointmentId: appointment._id.toString(),
      fromGuide: {
        id: fromGuide._id.toString(),
        number: fromGuide.number,
        usedSessions: fromGuide.usedSessions,
        remaining: fromGuide.remaining,
        status: fromGuide.status,
      },
      toGuide: {
        id: targetGuide._id.toString(),
        number: targetGuide.number,
        usedSessions: targetGuide.usedSessions,
        remaining: targetGuide.remaining,
        status: targetGuide.status,
      },
      validationWarnings: force ? validationErrors : [],
    };
  } catch (error) {
    await safeAbortTransaction(mongoSession);
    throw error;
  } finally {
    mongoSession.endSession();
  }
}

export default moveAppointmentGuide;
