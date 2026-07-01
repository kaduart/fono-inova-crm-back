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
import { syncAffectedViews } from '../../projections/syncAffectedViews.js';
import { handlePackageSessionUpdate } from '../../syncService.js';
import { emitSocket } from '../helpers/socketHelper.js';
import {
  buildError,
  checkDoctorPermission,
  determineActionType,
  sanitizeAppointmentPayload,
  toObjectIdString,
} from './_helpers.js';
import { recordAudit } from '../../auditLogService.js';

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

      const safeBody = sanitizeAppointmentPayload(payload);
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

      // Reativação de cancelado
      const wasCanceled = CANCELED_STATUSES.includes(appointment.operationalStatus);
      const isReactivating =
        wasCanceled && ['scheduled', 'pending', 'confirmed'].includes(updateData.operationalStatus);

      if (isReactivating) {
        const pkg = appointment.package;
        const isPrepaid = pkg && pkg.paymentType !== 'per-session' && pkg.model !== 'per_session';
        updateData.paymentStatus = isPrepaid ? 'package_paid' : 'unpaid';
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
      // handlePackageSessionUpdate primeiro: atualiza Session.date/time antes de buildar a PackagesView
      const action = determineActionType(payload, previousData);
      await handlePackageSessionUpdate(
        saved,
        action,
        user,
        { changes: payload, previousData }
      );

      await syncAffectedViews({
        event: 'appointment.updated',
        packageId: (saved.package?._id || saved.package)?.toString?.(),
        correlationId: `appt_put_${saved._id}_${Date.now()}`,
      });
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
