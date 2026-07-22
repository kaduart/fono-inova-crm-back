// back/services/appointment/commands/updateAppointmentCommand.js
/**
 * Update Appointment Command
 *
 * Responsabilidade: atualizar um agendamento mantendo consistência entre
 * Appointment, Session, Payment e Patient.
 *
 * Limitações conhecidas:
 * - packageId é imutável após criação. Mudança de pacote requer operação de domínio específica.
 * - Reversão automática de créditos reutilizáveis ao trocar serviceType/packageId
 *   NÃO é implementada neste command. Deve ser tratada no appointmentStateOrchestrator futuro.
 */

import mongoose from 'mongoose';
import Appointment from '../../../models/Appointment.js';
import Patient from '../../../models/Patient.js';
import Payment from '../../../models/Payment.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { resolveAndMapAppointmentDTO } from '../../../utils/appointmentDto.js';
import { CANCELED_STATUSES } from '../../../constants/appointmentStatus.js';
import { appointmentStateOrchestrator } from '../../appointmentStateOrchestrator.js';
import { syncEvent } from '../../syncService.js';

import { handlePackageSessionUpdate } from '../../syncService.js';
import { executeWithSession as restoreCanceledAppointment } from './restoreCanceledAppointmentCommand.js';
import { emitSocket } from '../helpers/socketHelper.js';
import {
  buildError,
  checkDoctorPermission,
  determineActionType,
  sanitizeAppointmentPayload,
  toObjectIdString,
} from './_helpers.js';
import { applyFinancialProtection } from '../policies/appointmentFinancialPolicy.js';
import { validateDoctorSpecialty } from '../policies/appointmentSpecialtyPolicy.js';
import { recordAudit } from '../../auditLogService.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';

export async function execute(id, payload, user) {
  if (!id) {
    throw buildError('ID do agendamento é obrigatório', 400, 'MISSING_ID');
  }

  let result;

  try {
    result = await runTransactionWithRetry(async (mongoSession) => {
      const appointment = await Appointment.findById(id)
        .populate('payment session package')
        .session(mongoSession);

      if (!appointment) {
        throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
      }

      checkDoctorPermission(appointment, user);

      // 🛡️ POLÍTICA FINANCEIRA: protege origens convenio/liminar contra downgrade acidental
      // para particular/pix em updates genéricos. Preserva valores atuais silenciosamente
      // quando não há flag explícita de conversão financeira (__allowFinancialConversion).
      const protectedPayload = applyFinancialProtection(appointment, payload);

      const safeBody = sanitizeAppointmentPayload(protectedPayload);
      const currentDate = new Date();

      // patientInfo é descartado pela sanitização (correto — não deve ir direto no $set do Appointment)
      // mas os campos de contato precisam ser propagados ao Patient (SSOT) e ao snapshot local
      const incomingPatientInfo = payload.patientInfo;
      const patientContactUpdate = {};
      if (incomingPatientInfo) {
        if (incomingPatientInfo.phone != null) patientContactUpdate.phone = incomingPatientInfo.phone;
        if (incomingPatientInfo.email !== undefined) patientContactUpdate.email = incomingPatientInfo.email;
        if (incomingPatientInfo.birthDate != null) patientContactUpdate.dateOfBirth = incomingPatientInfo.birthDate;
        if (incomingPatientInfo.fullName) patientContactUpdate.fullName = incomingPatientInfo.fullName;
      }

      // 🚫 packageId é imutável após criação
      const incomingPackageId = toObjectIdString(safeBody.package);
      const currentPackageId = toObjectIdString(appointment.package);
      if (incomingPackageId && currentPackageId && incomingPackageId !== currentPackageId) {
        throw buildError(
          'Mudança de pacote não é permitida via update. Use operação específica de migração de pacote.',
          409,
          'PACKAGE_CHANGE_NOT_SUPPORTED'
        );
      }

      const updateData = {
        ...safeBody,
        // Merge com o snapshot existente para não apagar campos não enviados nesta edição
        // Ex: usuário altera só phone → não perde fullName/email do snapshot
        ...(incomingPatientInfo ? { patientInfo: { ...(appointment.patientInfo?.toObject?.() ?? appointment.patientInfo ?? {}), ...incomingPatientInfo } } : {}),
        doctor: payload.doctorId || appointment.doctor,
        updatedBy: user?._id,
        updatedAt: currentDate,
      };

      // 🛡️ POLÍTICA DE ESPECIALIDADE: valida a combinação EFETIVA (médico e
      // especialidade resultantes deste update, trocados ou mantidos) antes
      // de escrever. Roda sempre — inclusive quando nada muda — porque é
      // barata e fecha a porta pra estados já inconsistentes se perpetuarem.
      const effectiveSpecialty = safeBody.specialty !== undefined ? safeBody.specialty : appointment.specialty;
      await validateDoctorSpecialty(
        { doctorId: toObjectIdString(updateData.doctor), specialty: effectiveSpecialty },
        mongoSession
      );

      const previousData = {
        doctor: appointment.doctor?.toString?.() || null,
        patient: appointment.patient?.toString?.() || appointment.patient,
        date: appointment.date,
        time: appointment.time,
        paymentAmount: appointment.paymentAmount,
        paymentMethod: appointment.paymentMethod,
        sessionType: appointment.sessionType,
        serviceType: appointment.serviceType,
        billingType: appointment.billingType,
        insuranceProvider: appointment.insuranceProvider,
        insuranceValue: appointment.insuranceValue,
        insuranceGuide: appointment.insuranceGuide?.toString?.() || appointment.insuranceGuide,
        insurancePlan: appointment.insurancePlan?.toString?.() || appointment.insurancePlan,
        operationalStatus: appointment.operationalStatus,
        clinicalStatus: appointment.clinicalStatus,
        package: appointment.package?.toString?.() || appointment.package,
        liminarContract: appointment.liminarContract?.toString?.() || appointment.liminarContract,
        sessionValue: appointment.sessionValue,
        cancelReason: appointment.cancelReason,
        rescheduledFrom: appointment.rescheduledFrom?.toString?.() || appointment.rescheduledFrom,
        originalAppointmentId: appointment.originalAppointmentId?.toString?.() || appointment.originalAppointmentId,
        notes: appointment.notes,
      };

      // 🛡️ GUARDA DE DOMÍNIO: operationalStatus é state machine — não pode ser alterado
      // por update genérico. completed → completeSessionV2; canceled → cancelAppointment.
      const incomingOperationalStatus = updateData.operationalStatus;
      if (incomingOperationalStatus === 'completed' && appointment.operationalStatus !== 'completed') {
        throw buildError(
          'Transição inválida: operationalStatus=completed só pode ser atingido via completeSessionV2',
          409,
          'FORBIDDEN_MANUAL_COMPLETE'
        );
      }
      if (incomingOperationalStatus === 'canceled' && !CANCELED_STATUSES.includes(appointment.operationalStatus)) {
        throw buildError(
          'Transição inválida: operationalStatus=canceled só pode ser atingido via cancelAppointment',
          409,
          'FORBIDDEN_MANUAL_CANCEL'
        );
      }

      // 🛡️ GUARDA DE DOMÍNIO: clinicalStatus=completed exige operationalStatus=completed
      const incomingClinicalStatus = updateData.clinicalStatus;
      const effectiveOperationalStatus = incomingOperationalStatus || appointment.operationalStatus;
      if (incomingClinicalStatus === 'completed' && effectiveOperationalStatus !== 'completed') {
        throw buildError(
          'Transição inválida: clinicalStatus=completed requer operationalStatus=completed',
          409,
          'CLINICAL_COMPLETION_REQUIRES_OPERATIONAL_COMPLETION'
        );
      }

      // Reativação de cancelado
      const wasCanceled = CANCELED_STATUSES.includes(appointment.operationalStatus);
      const isReactivating =
        wasCanceled && ['scheduled', 'pending', 'confirmed'].includes(updateData.operationalStatus);

      if (isReactivating) {
        const pkg = appointment.package;
        const isPrepaid = pkg && pkg.paymentType !== 'per-session' && pkg.model !== 'per_session';
        if (isPrepaid) {
          updateData.paymentStatus = 'package_paid';
        } else {
          // per-session/avulso: não assume 'unpaid' cegamente — verifica se a
          // sessão cancelada tinha sido paga antes, pra não perder esse estado
          // na reativação (session.original* é gravado pelo cancelAppointmentCommand).
          const canceledSession = appointment.session;
          const wasPaid = !!(
            canceledSession?.originalIsPaid ||
            canceledSession?.originalPaymentStatus === 'paid' ||
            (canceledSession?.originalPartialAmount && canceledSession.originalPartialAmount > 0)
          );
          updateData.paymentStatus = wasPaid ? 'paid' : 'unpaid';
        }

        // 🔄 Restaura Session/Package/Payment ao estado anterior ao cancelamento
        // (inverso simétrico de cancelAppointmentCommand). Roda ANTES do
        // Appointment.findByIdAndUpdate abaixo, com o `appointment` ainda no
        // status pré-reativação e populado (session/payment/package).
        await restoreCanceledAppointment(
          appointment,
          { reason: payload.reason || 'Reativação de agendamento cancelado' },
          user,
          mongoSession
        );
      }

      // Atualiza appointment usando $set (evita corromper documento populado)
      const updatedAppointment = await Appointment.findByIdAndUpdate(
        id,
        { $set: updateData },
        {
          new: true,
          session: mongoSession,
          runValidators: true,
          __fromFinancialGuard: true,
          __guardContext: 'FINANCIAL',
        }
      ).populate('payment session package');

      if (!updatedAppointment) {
        throw buildError('Agendamento não encontrado após atualização', 404, 'APPOINTMENT_NOT_FOUND');
      }

      // Propaga mudanças de contato ao Patient (source of truth para dados pessoais do paciente)
      const currentPatientId = toObjectIdString(appointment.patient);
      if (currentPatientId && Object.keys(patientContactUpdate).length > 0) {
        await Patient.findByIdAndUpdate(
          currentPatientId,
          { $set: patientContactUpdate },
          { session: mongoSession }
        );
      }

      // Sincroniza Session vinculada
      if (updatedAppointment.session) {
        const { syncSessionFromAppointment } = await import('../../appointmentSessionSyncService.js');
        await syncSessionFromAppointment(updatedAppointment, mongoSession);
      }

      // Atualiza Payment (somente se não for pacote)
      if (!updatedAppointment.package && updatedAppointment.payment) {
        const isConvenioPayment = updatedAppointment.payment?.billingType === 'convenio';

        const paymentSet = {
          doctor: updateData.doctor || updatedAppointment.doctor,
          serviceDate: updateData.date ?? updatedAppointment.date,
          serviceType: updateData.serviceType ?? updatedAppointment.serviceType,
          updatedAt: currentDate,
        };

        // Campos financeiros: nunca sobrescrever payment de convênio com fallback 'particular'
        if (!isConvenioPayment) {
          Object.assign(paymentSet, {
            amount: updateData.amount ?? updateData.paymentAmount ?? updatedAppointment.paymentAmount,
            paymentMethod: updateData.paymentMethod ?? updatedAppointment.paymentMethod,
            billingType: updateData.billingType ?? updatedAppointment.billingType ?? 'particular',
            insuranceProvider: updateData.insuranceProvider ?? updatedAppointment.insuranceProvider,
            insuranceValue: updateData.insuranceValue ?? updatedAppointment.insuranceValue,
            authorizationCode: updateData.authorizationCode ?? updatedAppointment.authorizationCode,
          });
        }

        await Payment.findByIdAndUpdate(
          updatedAppointment.payment,
          { $set: paymentSet },
          { session: mongoSession, new: true }
        );
      }

      // Atualiza Patient.appointments se o paciente mudou
      const newPatientId = toObjectIdString(updateData.patient);
      const previousPatientId = toObjectIdString(previousData.patient);
      if (newPatientId && previousPatientId && newPatientId !== previousPatientId) {
        await Patient.findByIdAndUpdate(
          previousPatientId,
          { $pull: { appointments: updatedAppointment._id } },
          { session: mongoSession }
        );
        await Patient.findByIdAndUpdate(
          newPatientId,
          { $addToSet: { appointments: updatedAppointment._id } },
          { session: mongoSession }
        );
      }

      // Publica evento canônico para projection workers
      await saveToOutbox({
        eventType: 'APPOINTMENT_UPDATED',
        aggregateType: 'appointment',
        aggregateId: updatedAppointment._id.toString(),
        payload: {
          appointmentId: updatedAppointment._id.toString(),
          patientId: toObjectIdString(updatedAppointment.patient),
          doctorId: toObjectIdString(updatedAppointment.doctor),
          packageId: toObjectIdString(updatedAppointment.package),
          previousPatientId,
          changes: Object.keys(updateData)
        },
        correlationId: `appt_put_${updatedAppointment._id}_${Date.now()}`
      }, mongoSession);

      return { saved: updatedAppointment, previousData };
    });
  } catch (error) {
    if (error.message?.includes('Write conflict') || error.code === 112 || error.codeName === 'WriteConflict') {
      throw buildError(
        'Outro usuário está editando este agendamento. Recarregue a página e tente novamente.',
        409,
        'WRITE_CONFLICT'
      );
    }

    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).reduce((acc, err) => {
        acc[err.path] = err.message;
        return acc;
      }, {});
      const err = buildError('Dados inválidos', 400, 'VALIDATION_ERROR');
      err.fields = errors;
      throw err;
    }

    if (error.name === 'CastError') {
      throw buildError('O formato do ID fornecido é inválido', 400, 'INVALID_ID');
    }

    throw error;
  }

  const { saved, previousData } = result;

  // Side effects pós-transação (não podem falhar a requisição)
  try {
    await emitSocket('appointmentUpdated', {
      _id: saved._id,
      patient: saved.patient,
      doctor: saved.doctor,
      date: saved.date,
      time: saved.time,
      specialty: saved.specialty,
      operationalStatus: saved.operationalStatus,
      source: 'crm_update',
    });
  } catch (socketErr) {
    console.error('[updateAppointmentCommand] Erro ao emitir socket:', socketErr.message);
  }

  // Consistência final — await garantido, erro não falha a resposta
  try {
    await syncEvent(saved, 'appointment');

    await appointmentStateOrchestrator({
      appointment: saved.toObject(),
      updates: {},
      correlationId: `appt_put_${saved._id}_${Date.now()}`,
    });

    if (saved.serviceType === 'package_session') {
      // handlePackageSessionUpdate atualiza Session.date/time
      const action = determineActionType(payload, previousData);
      await handlePackageSessionUpdate(
        saved,
        action,
        user,
        { changes: payload, previousData }
      );
      // A PackagesView será atualizada pelo package-projection worker via evento APPOINTMENT_UPDATED.
    }
  } catch (err) {
    console.error('[updateAppointmentCommand] Erro na sincronização pós-atualização:', err);
  }

  await recordAudit({
    user,
    action: 'appointment_updated',
    entityType: 'Appointment',
    entityId: saved._id,
    before: previousData,
    after: saved,
    source: 'appointment_command:updateAppointmentCommand',
    correlationId: saved.correlationId,
  });

  return {
    data: await resolveAndMapAppointmentDTO(saved),
    message: 'Agendamento atualizado com sucesso',
  };
}

export default { execute };
