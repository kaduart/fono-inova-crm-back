// back/services/appointment/commands/confirmPreAgendamentoCommand.js
/**
 * Confirm Pre-Agendamento Command
 *
 * Responsabilidade: transicionar um Appointment de operationalStatus
 * 'pre_agendado' para 'scheduled' NO MESMO DOCUMENTO — resolvendo
 * Patient/Doctor quando ainda não estiverem setados, e criando
 * Session/Payment quando ainda não existirem.
 *
 * Substitui o padrão legado (criar um Appointment novo via
 * appointmentHybridService + cancelar o pré-agendamento original),
 * que já causou duplicação de registros em produção.
 *
 * Escopo: só cobre billingType particular (mesmo escopo do fluxo legado
 * que este command substitui). Pacote/convênio não são tratados aqui.
 */

import Appointment from '../../../models/Appointment.js';
import Patient from '../../../models/Patient.js';
import Payment from '../../../models/Payment.js';
import Session from '../../../models/Session.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { resolveAndMapAppointmentDTO } from '../../../utils/appointmentDto.js';
import { findDoctorByName } from '../../../utils/doctorHelper.js';
import { createSessionFromAppointment } from '../../appointmentSessionSyncService.js';
import { buildError, assertAppointmentTransition } from './_helpers.js';
import { emitSocket } from '../helpers/socketHelper.js';
import { recordAudit } from '../../auditLogService.js';
import { syncEvent } from '../../syncService.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';

export async function execute(id, payload, user) {
  if (!id) {
    throw buildError('ID do pré-agendamento é obrigatório', 400, 'MISSING_ID');
  }

  const {
    doctorId,
    professionalId,
    date,
    time,
    notes,
    sessionValue = 0,
    paymentMethod = 'pix',
  } = payload || {};

  let result;

  try {
    result = await runTransactionWithRetry(async (mongoSession) => {
      const pre = await Appointment.findById(id).populate('session payment').session(mongoSession);

      if (!pre) {
        throw buildError('Pré-agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
      }

      // Idempotência de domínio: já confirmado — retorna sem reprocessar.
      if (pre.operationalStatus !== 'pre_agendado') {
        return { saved: pre, alreadyConfirmed: true };
      }

      assertAppointmentTransition(pre.operationalStatus, 'scheduled', 'confirmPreAgendamentoCommand');

      if (pre.package || pre.insuranceGuide) {
        throw buildError(
          'Confirmação de pré-agendamento com pacote/convênio não é suportada por este fluxo',
          409,
          'UNSUPPORTED_BILLING_CONTEXT'
        );
      }

      // Resolve doutor: payload -> doctor já setado no pré-agendamento -> nome do profissional
      let resolvedDoctorId = doctorId || professionalId;
      if (!resolvedDoctorId && pre.doctor) {
        resolvedDoctorId = pre.doctor.toString();
      }
      if (!resolvedDoctorId && pre.professionalName) {
        const doc = await findDoctorByName(pre.professionalName).catch(() => null);
        if (doc) resolvedDoctorId = doc._id.toString();
      }
      if (!resolvedDoctorId) {
        throw buildError('Profissional não encontrado', 400, 'DOCTOR_NOT_FOUND');
      }

      // Resolve paciente: já vinculado -> busca por telefone -> cria novo (exige birthDate)
      let patientId = pre.patient;
      if (!patientId && pre.patientInfo?.phone) {
        const cleanPhone = pre.patientInfo.phone.replace(/\D/g, '');
        const existingPatient = await Patient.findOne({
          phone: { $regex: cleanPhone.slice(-10) }
        }).session(mongoSession).lean();
        if (existingPatient) {
          patientId = existingPatient._id.toString();
        }
      }
      if (!patientId && pre.patientInfo?.fullName) {
        if (!pre.patientInfo.birthDate) {
          throw buildError(
            'Data de nascimento obrigatória para confirmar agendamento',
            400,
            'BIRTHDATE_REQUIRED_ON_CONFIRM'
          );
        }
        const newPatient = new Patient({
          fullName: pre.patientInfo.fullName,
          phone: pre.patientInfo.phone || '',
          dateOfBirth: new Date(pre.patientInfo.birthDate),
          email: pre.patientInfo.email || null,
          source: 'agenda_externa_v2',
        });
        await newPatient.save({ session: mongoSession });
        patientId = newPatient._id.toString();
      }
      if (!patientId) {
        throw buildError('Não foi possível criar/encontrar o paciente', 400, 'PATIENT_RESOLUTION_FAILED');
      }

      const resolvedDateStr = date || (pre.date instanceof Date
        ? pre.date.toISOString().split('T')[0]
        : String(pre.date || '').split('T')[0]);

      // Transição in-place — mesmo documento, mesmo _id.
      pre.patient = patientId;
      pre.doctor = resolvedDoctorId;
      pre.date = new Date(`${resolvedDateStr}T12:00:00-03:00`);
      if (time) pre.time = time;
      pre.sessionValue = Number(sessionValue) || 0;
      pre.paymentMethod = paymentMethod;
      pre.billingType = 'particular';
      pre.notes = notes || pre.notes || '';
      pre.operationalStatus = 'scheduled';
      pre.clinicalStatus = 'pending';
      pre.paymentStatus = 'pending';
      if (!pre.patientInfo?.fullName) {
        pre.patientInfo = {
          fullName: pre.patientInfo?.fullName || '',
          phone: pre.patientInfo?.phone || '',
          birthDate: pre.patientInfo?.birthDate || null,
          email: pre.patientInfo?.email || null,
        };
      }
      pre.history = pre.history || [];
      pre.history.push({
        action: 'pre_agendamento_confirmado',
        changedBy: user?._id,
        timestamp: new Date(),
        context: 'operacional',
        details: { from: 'pre_agendado', to: 'scheduled' },
      });

      await pre.save({ session: mongoSession });

      // Cria Session se ainda não existir.
      const hadSession = !!pre.session;
      if (!hadSession) {
        const shouldPay = pre.sessionValue > 0;
        const newSession = await createSessionFromAppointment(pre, mongoSession);
        await Session.findByIdAndUpdate(
          newSession._id,
          { visualFlag: shouldPay ? 'blocked' : 'ok', correlationId: pre.correlationId },
          { session: mongoSession }
        );
        pre.session = newSession._id;
        await pre.save({ session: mongoSession });
      }

      // Cria Payment se ainda não existir e houver valor a cobrar.
      const shouldCreatePayment = !pre.payment && pre.sessionValue > 0;
      if (shouldCreatePayment) {
        const payment = new Payment({
          patient: patientId,
          doctor: resolvedDoctorId,
          appointment: pre._id,
          session: pre.session,
          amount: pre.sessionValue,
          paymentDate: new Date(),
          paymentMethod: pre.paymentMethod,
          status: 'pending',
          serviceType: pre.serviceType || 'individual_session',
          billingType: 'particular',
          correlationId: pre.correlationId,
          notes: 'Pagamento referente à sessão',
        });
        await payment.save({ session: mongoSession });
        pre.payment = payment._id;
        await pre.save({ session: mongoSession });
      }

      await saveToOutbox({
        eventType: 'APPOINTMENT_UPDATED',
        aggregateType: 'appointment',
        aggregateId: pre._id.toString(),
        payload: {
          appointmentId: pre._id.toString(),
          patientId: patientId?.toString?.() || patientId,
          doctorId: resolvedDoctorId,
          changes: ['operationalStatus', 'doctor', 'patient', 'date', 'time', 'session', 'payment'],
        },
        correlationId: `preagendamento_confirm_${pre._id}_${Date.now()}`,
      }, mongoSession);

      return { saved: pre, alreadyConfirmed: false };
    });
  } catch (error) {
    if (error.message?.includes('Write conflict') || error.code === 112 || error.codeName === 'WriteConflict') {
      throw buildError(
        'Outro usuário está confirmando este pré-agendamento. Recarregue a página e tente novamente.',
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
    throw error;
  }

  const { saved, alreadyConfirmed } = result;

  if (alreadyConfirmed) {
    return {
      data: await resolveAndMapAppointmentDTO(saved),
      message: 'Pré-agendamento já havia sido confirmado.',
      skipped: true,
    };
  }

  try {
    await emitSocket('appointmentUpdated', {
      _id: saved._id,
      patient: saved.patient,
      doctor: saved.doctor,
      date: saved.date,
      time: saved.time,
      specialty: saved.specialty,
      operationalStatus: saved.operationalStatus,
      source: 'preagendamento_confirm',
    });
  } catch (socketErr) {
    console.error('[confirmPreAgendamentoCommand] Erro ao emitir socket:', socketErr.message);
  }

  try {
    await syncEvent(saved, 'appointment');
  } catch (err) {
    console.error('[confirmPreAgendamentoCommand] Erro na sincronização pós-confirmação:', err);
  }

  await recordAudit({
    user,
    action: 'preagendamento_confirmado',
    entityType: 'Appointment',
    entityId: saved._id,
    before: { operationalStatus: 'pre_agendado' },
    after: saved,
    source: 'appointment_command:confirmPreAgendamentoCommand',
    correlationId: saved.correlationId,
  });

  return {
    data: await resolveAndMapAppointmentDTO(saved),
    message: 'Agendamento confirmado com sucesso',
  };
}

export default { execute };
