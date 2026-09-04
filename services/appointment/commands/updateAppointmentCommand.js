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
import { handlePaymentEvent } from '../../../projections/paymentsProjection.js';
import { createDepositAndBalancePayments, findDepositPayment, assertNewTotalCoversPaidDeposit, assertNotDepositPayment } from '../../../domain/payment/depositBalance.js';

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
      const requestedDeposit = Number(payload.depositAmount || 0);
      const requestedDepositMethod = payload.depositPaymentMethod;
      const requestedDepositPaidAt = payload.depositPaidAt;
      delete safeBody.depositAmount;
      delete safeBody.depositPaymentMethod;
      delete safeBody.depositPaidAt;
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

      // 🛡️ GUARD (patch operacional Particular/Pacote): sessão de pacote já
      // concluída não pode ter data/hora/profissional reescritos por aqui — o
      // histórico (sessionsDone incrementado, Payment liquidado) já foi
      // processado. Cancelamento/estorno de sessão completed continua exatamente
      // como está, via cancelAppointmentCommand (rota e command separados, não
      // passam por este update genérico). packageId já é imutável incondicionalmente
      // (guard acima), então só falta cobrir date/time/doctor aqui.
      if (appointment.serviceType === 'package_session' && appointment.operationalStatus === 'completed') {
        const normalizeDateOnly = (value) => {
          if (!value) return null;
          const d = new Date(value);
          return isNaN(d.getTime()) ? String(value) : d.toISOString().substring(0, 10);
        };
        const incomingDoctorIdForGuard = payload.doctorId ? toObjectIdString(payload.doctorId) : null;
        const attemptsDateChange = safeBody.date !== undefined
          && normalizeDateOnly(safeBody.date) !== normalizeDateOnly(appointment.date);
        const attemptsTimeChange = safeBody.time !== undefined && safeBody.time !== appointment.time;
        const attemptsDoctorChange = incomingDoctorIdForGuard !== null
          && incomingDoctorIdForGuard !== toObjectIdString(appointment.doctor);

        if (attemptsDateChange || attemptsTimeChange || attemptsDoctorChange) {
          throw buildError(
            'Sessão de pacote já concluída não pode ter data, horário ou profissional alterados — o histórico é imutável após a conclusão.',
            409,
            'PACKAGE_SESSION_COMPLETED_IMMUTABLE'
          );
        }
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

      if (requestedDeposit > 0) {
        const effectiveBillingType = updateData.billingType ?? appointment.billingType;
        const effectiveTotal = Number(updateData.sessionValue ?? updateData.paymentAmount ?? appointment.sessionValue ?? appointment.paymentAmount ?? 0);

        if (effectiveBillingType !== 'particular' || appointment.package) {
          throw buildError('Sinal recebido só pode ser registrado em consulta particular avulsa.', 409, 'DEPOSIT_NOT_ALLOWED');
        }
        if (CANCELED_STATUSES.includes(appointment.operationalStatus) || appointment.operationalStatus === 'completed') {
          throw buildError('Não é possível registrar sinal em um atendimento cancelado ou concluído.', 409, 'DEPOSIT_NOT_ALLOWED_FOR_STATUS');
        }
        if (!requestedDepositMethod) {
          throw buildError('A forma de pagamento do sinal recebido é obrigatória.', 400, 'DEPOSIT_PAYMENT_METHOD_REQUIRED');
        }
        assertNewTotalCoversPaidDeposit(effectiveTotal, requestedDeposit);

        const depositResult = await createDepositAndBalancePayments({
          patientId: toObjectIdString(appointment.patient),
          doctorId: toObjectIdString(updateData.doctor),
          appointmentId: appointment._id,
          sessionId: toObjectIdString(appointment.session),
          billingType: 'particular',
          sessionValue: effectiveTotal,
          depositAmount: requestedDeposit,
          depositPaymentMethod: requestedDepositMethod,
          depositPaidAt: requestedDepositPaidAt,
          balancePaymentMethod: updateData.paymentMethod ?? appointment.paymentMethod,
          correlationId: appointment.correlationId || `appointment_${appointment._id}`,
          userId: user?._id,
        }, mongoSession);

        updateData.payment = depositResult.balancePayment._id;
        updateData.paymentStatus = depositResult.balancePayment.status === 'paid' ? 'paid' : 'partial';
        updateData.isPaid = depositResult.balancePayment.status === 'paid';
      }

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
      // 🛡️ Chegando aqui com incomingOperationalStatus === 'completed', o guard acima já
      // garantiu que appointment.operationalStatus também é 'completed' (admin-edit de um
      // agendamento já completado, permanecendo completado — não é uma transição real).
      // O model tem um guard próprio (pre findOneAndUpdate) que bloqueia QUALQUER
      // $set.operationalStatus='completed' sem essa flag, sem saber a distinção acima —
      // por isso precisa ser sinalizado explicitamente aqui, e só aqui.
      if (incomingOperationalStatus === 'completed') {
        updateData._fromCompleteService = true;
      }
      if (incomingOperationalStatus === 'canceled' && !CANCELED_STATUSES.includes(appointment.operationalStatus)) {
        throw buildError(
          'Transição inválida: operationalStatus=canceled só pode ser atingido via cancelAppointment',
          409,
          'FORBIDDEN_MANUAL_CANCEL'
        );
      }
      // 🚨 FIX (2026-09-04): faltava o inverso do guard de FORBIDDEN_MANUAL_COMPLETE
      // acima — bloqueava ENTRAR em 'completed' fora do completeSessionV2, mas não
      // SAIR de 'completed' por aqui. Achado real: Isis Caldas Rebelatto, pacote TO-3
      // (sessionsDone incrementado 2x pra 1 sessão real) — 17:49 completou via
      // completeSessionV2 (sessionsDone 2→3, dentro do limite), 18:32 um PUT genérico
      // reverteu operationalStatus completed→scheduled por este endpoint (sem tocar
      // sessionsDone, diferente do cancelAppointmentCommand que desconta via
      // restorePackageOnCancel), e 18:33 completou de novo (agora legitimamente
      // 'scheduled'→'completed', sessionsDone 3→4) — 3 sessões reais, contador em 4.
      // Reabrir uma sessão completada tem que ser uma operação própria e simétrica
      // (desfazer sessionsDone/Payment), não um efeito colateral silencioso do PUT
      // genérico de edição.
      if (appointment.operationalStatus === 'completed'
        && incomingOperationalStatus !== undefined
        && incomingOperationalStatus !== 'completed') {
        throw buildError(
          'Transição inválida: não é possível reverter operationalStatus de um agendamento já completado por aqui — use cancelAppointment (estorno) se o objetivo é desfazer a sessão.',
          409,
          'FORBIDDEN_MANUAL_UNCOMPLETE'
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
        const isConvenio = appointment.billingType === 'convenio' || appointment.payment?.billingType === 'convenio';
        if (isConvenio) {
          // Convênio nunca tem 'unpaid'/'paid' como shadow — o paciente não paga
          // no dia, o convênio fatura em lote depois. Mesmo valor usado na
          // criação normal da sessão (ver ConvenioHandler / REGRAS_NEGOCIO_CONSOLIDADO.md).
          updateData.paymentStatus = 'pending_receipt';
        } else if (isPrepaid) {
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

        // 🛡️ SINAL: updatedAppointment.payment é sempre o saldo/standard (nunca o
        // sinal — garantido na criação, ver domain/payment/depositBalance.js).
        // Airbag defensivo: nunca deixa este bloco escrever num Payment de papel
        // 'deposit' por alguma inconsistência de dados.
        assertNotDepositPayment(updatedAppointment.payment);

        const paymentSet = {
          doctor: updateData.doctor || updatedAppointment.doctor,
          serviceDate: updateData.date ?? updatedAppointment.date,
          serviceType: updateData.serviceType ?? updatedAppointment.serviceType,
          updatedAt: currentDate,
        };

        // Campos financeiros: nunca sobrescrever payment de convênio com fallback 'particular'
        if (!isConvenioPayment) {
          Object.assign(paymentSet, {
            paymentMethod: updateData.paymentMethod ?? updatedAppointment.paymentMethod,
            billingType: updateData.billingType ?? updatedAppointment.billingType ?? 'particular',
            insuranceProvider: updateData.insuranceProvider ?? updatedAppointment.insuranceProvider,
            insuranceValue: updateData.insuranceValue ?? updatedAppointment.insuranceValue,
            authorizationCode: updateData.authorizationCode ?? updatedAppointment.authorizationCode,
          });

          // 🎯 SINAL + SALDO: se esta consulta tem um sinal pago, editar o valor
          // total NUNCA pode sobrescrever o saldo com o total cheio de novo — só
          // o que falta (total - sinal). E o novo total nunca pode ficar menor
          // que o sinal já recebido (erro de domínio, rejeita a edição).
          const incomingTotal = updateData.amount ?? updateData.paymentAmount ?? updateData.sessionValue;
          const effectiveTotal = incomingTotal ?? updatedAppointment.sessionValue ?? updatedAppointment.paymentAmount;

          if (requestedDeposit > 0) {
            // O comando de sinal acima já criou/ajustou deposit + balance com os
            // valores corretos. Não execute novamente nenhuma regra de amount
            // neste update genérico: ele poderia transformar o total da consulta
            // em valor recebido ou recalcular o mesmo fluxo duas vezes.
          } else if (updatedAppointment.payment.paymentRole === 'balance' && updatedAppointment.billingType === 'particular') {
            const deposit = await findDepositPayment(
              { appointmentId: updatedAppointment._id, billingType: updatedAppointment.billingType },
              mongoSession
            );
            const depositPaid = deposit?.status === 'paid' ? (deposit.amount || 0) : 0;

            if (incomingTotal !== undefined) {
              assertNewTotalCoversPaidDeposit(effectiveTotal, depositPaid);
            }

            paymentSet.amount = Math.max(Number(effectiveTotal || 0) - depositPaid, 0);
          } else if (updatedAppointment.payment.status === 'paid') {
            // Valor já recebido é fato financeiro imutável. Uma edição do valor
            // total da consulta nunca pode inflar retroativamente Payment.amount
            // (ex.: recebeu R$50 e editou sessionValue=R$500).
          } else if (incomingTotal !== undefined) {
            paymentSet.amount = incomingTotal;
          } else if (updatedAppointment.paymentAmount !== undefined) {
            paymentSet.amount = updatedAppointment.paymentAmount;
          }
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

    if (error.code === 11000 && /unique_appointment_slot/.test(error.message || '')) {
      throw buildError(
        'Já existe um agendamento para este profissional nesta data e horário. Escolha outro horário ou cancele o agendamento existente antes de reverter este.',
        409,
        'APPOINTMENT_SLOT_TAKEN'
      );
    }

    throw error;
  }

  const { saved, previousData } = result;

  // Efeitos independentes pós-commit rodam em paralelo. A sequência interna
  // orquestrador → pacote é preservada porque ambos podem tocar a Session.
  const postCommitTasks = [
    emitSocket('appointmentUpdated', {
      _id: saved._id,
      patient: saved.patient,
      doctor: saved.doctor,
      date: saved.date,
      time: saved.time,
      specialty: saved.specialty,
      operationalStatus: saved.operationalStatus,
      source: 'crm_update',
    }),
    syncEvent(saved, 'appointment'),
    handlePaymentEvent({
        type: 'APPOINTMENT_UPDATED',
        payload: { appointmentId: saved._id.toString() },
        timestamp: new Date().toISOString()
    }).catch((viewErr) => {
      console.error('[updateAppointmentCommand] Falha ao atualizar PaymentsView (non-fatal):', viewErr.message);
    }),
    recordAudit({
      user,
      action: 'appointment_updated',
      entityType: 'Appointment',
      entityId: saved._id,
      before: previousData,
      after: saved,
      source: 'appointment_command:updateAppointmentCommand',
      correlationId: saved.correlationId,
    }),
    (async () => {
      await appointmentStateOrchestrator({
        appointment: saved.toObject(),
        updates: {},
        correlationId: `appt_put_${saved._id}_${Date.now()}`,
      });

      // Mantém a ordem após o orquestrador, pois os dois fluxos alteram Session.
    if (saved.serviceType === 'package_session') {
      const action = determineActionType(payload, previousData);
      await handlePackageSessionUpdate(
        saved,
        action,
        user,
        { changes: payload, previousData }
      );
      // A PackagesView será atualizada pelo package-projection worker via evento APPOINTMENT_UPDATED.
    }
    })(),
  ];

  const postCommitResults = await Promise.allSettled(postCommitTasks);
  for (const taskResult of postCommitResults) {
    if (taskResult.status === 'rejected') {
      console.error('[updateAppointmentCommand] Erro na sincronização pós-atualização:', taskResult.reason);
    }
  }

  return {
    data: await resolveAndMapAppointmentDTO(saved),
    message: 'Agendamento atualizado com sucesso',
  };
}

export default { execute };
