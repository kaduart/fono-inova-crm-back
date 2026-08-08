// back/services/appointment/commands/createAppointmentCommand.js
/**
 * Create Appointment Command
 *
 * Responsabilidade: orquestrar a criação de um agendamento.
 *
 * Regras:
 * - NÃO implementa lógica de criação em si — delega para serviços especializados
 * - HybridService é a fonte de verdade para create
 * - Adiciona side effects de compatibilidade: lead, socket, patient.appointments
 * - Reaproveitamento de crédito de sessão cancelada é tratado atomicamente
 */

import mongoose from 'mongoose';
import { appointmentHybridService } from '../../appointmentHybridService.js';
import billingOrchestrator from '../../billing/BillingOrchestrator.js';
import { handleAdvancePayment } from '../../../helpers/handleAdvancePayment.js';
import { claimReusableCredit, buildCreditApplication } from '../../package/packageCreditService.js';
import { ensureLeadForAppointment, buildLeadSnapshot } from '../helpers/leadHelper.js';
import { validateDoctorSpecialty } from '../policies/appointmentSpecialtyPolicy.js';
import { emitSocket } from '../helpers/socketHelper.js';
import Patient from '../../../models/Patient.js';
import Session from '../../../models/Session.js';
import Appointment from '../../../models/Appointment.js';
import Leads from '../../../models/Leads.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { recordAudit } from '../../auditLogService.js';
import { pickAppointmentClientFields } from '../contracts/appointmentClientFields.js';

function isInsuranceAppointment(body) {
  return (
    body.billingType === 'insurance' ||
    body.billingType === 'convenio' ||
    body.insuranceGuideId ||
    body.insurance
  );
}

function buildError(message, status = 500, code = 'INTERNAL_ERROR') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Orquestra a criação de agendamento.
 *
 * @param {Object} payload - Dados da requisição
 * @param {Object} user - Usuário autenticado
 * @param {Object} res - Response Express (apenas para handleAdvancePayment legado)
 * @returns {Promise<Object>} - { appointment, session, payment, message, reusedPayment }
 */
export async function execute(payload, user, res = null) {
  // 🔹 Convênio: delega para BillingOrchestrator
  if (isInsuranceAppointment(payload)) {
    const isAgendaService = user?.isService === true && user?.id === 'agenda-service';
    const billingResult = await billingOrchestrator.handleBilling({
      ...payload,
      createdBy: user?._id,
      operationalStatus: isAgendaService ? 'pre_agendado' : payload.operationalStatus,
    });

    // Garante que o front sempre receba um appointment populado em data
    const appointmentId = billingResult?.appointmentId || billingResult?.appointment?._id;
    const populatedAppointment = appointmentId
      ? await Appointment.findById(appointmentId).populate('patient doctor session payment package').lean()
      : null;

    if (populatedAppointment) {
      await recordAudit({
        user,
        action: 'appointment_created',
        entityType: 'Appointment',
        entityId: populatedAppointment._id,
        before: null,
        after: populatedAppointment,
        source: 'appointment_command:createAppointmentCommand:insurance',
        correlationId: populatedAppointment.correlationId,
      });
    }

    return {
      appointment: populatedAppointment,
      session: null,
      payment: null,
      data: populatedAppointment || billingResult,
      message: billingResult.message || 'Agendamento de convênio processado',
      reusedPayment: false,
    };
  }

  // 🔹 Pagamento adiantado: delega para helper legado
  if (payload.isAdvancePayment || (payload.advanceSessions && payload.advanceSessions.length > 0)) {
    if (!res) {
      throw buildError('Pagamento adiantado requer response object', 500, 'ADVANCE_PAYMENT_NO_RES');
    }
    return await handleAdvancePayment({ body: payload, user }, res);
  }

  // 🔹 Casos normais: HybridService + side effects
  return await createWithHybridService(payload, user);
}

async function createWithHybridService(payload, user) {
  const {
    patientId,
    doctorId,
    packageId,
    serviceType,
    paymentMethod,
    source,
    preAgendamentoId,
    leadId: inputLeadId,
  } = payload;

  // Identidade do service token da Agenda Externa (ver middleware/amandaAuth.js:22)
  const isAgendaService = user?.isService === true && user?.id === 'agenda-service';

  const amount = parseFloat(payload.paymentAmount) || parseFloat(payload.sessionValue) || 0;
  const isPackageSession = serviceType === 'package_session';
  const isNoAmountPackageSession = isPackageSession && amount <= 0;

  // 🔹 Cria paciente quando isNewPatient=true e patientInfo é fornecido
  let effectivePatientId = patientId;
  let effectivePatientSnapshot = null;
  if (!effectivePatientId && payload.isNewPatient && payload.patientInfo) {
    const { fullName, phone, birthDate, email } = payload.patientInfo;
    if (fullName && birthDate) {
      let existingPatient = null;
      if (phone) {
        const normalizedPhone = phone.replace(/\D/g, '');
        const escapedName = fullName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        existingPatient = await Patient.findOne({
          fullName: { $regex: new RegExp(`^${escapedName}$`, 'i') },
          phone: normalizedPhone
        }).lean();
      }
      if (existingPatient?._id) {
        effectivePatientId = existingPatient._id.toString();
        effectivePatientSnapshot = existingPatient;
      } else {
        const newPatient = await Patient.create({
          fullName: fullName.trim(),
          dateOfBirth: birthDate,
          phone: phone?.replace(/\D/g, '') || undefined,
          email: email?.toLowerCase() || undefined,
          createdBy: user?._id
        });
        effectivePatientId = newPatient._id.toString();
        effectivePatientSnapshot = newPatient.toObject();
      }
    }
  }

  if (!effectivePatientId) {
    throw buildError('Paciente é obrigatório para criar agendamento', 400, 'MISSING_PATIENT');
  }

  // 🛡️ POLÍTICA DE ESPECIALIDADE: bloqueia agendamento cujo doctor.specialty
  // não corresponda à specialty informada (ver appointmentSpecialtyPolicy.js).
  await validateDoctorSpecialty({ doctorId, specialty: payload.specialty });

  // 🔹 Side effect: lead é criado/vinculado FORA da transação principal
  let effectiveLeadId = inputLeadId || null;
  let leadSnapshot = null;

  if (effectiveLeadId) {
    await Leads.findByIdAndUpdate(effectiveLeadId, { patientJourneyStage: 'ativo' });
  } else {
    effectiveLeadId = await ensureLeadForAppointment(
      effectivePatientId,
      {
        serviceType,
        date: payload.date,
        time: payload.time,
        specialty: payload.specialty,
      },
      source || 'agenda_direta',
      null,
      effectivePatientSnapshot
    );
  }

  if (effectiveLeadId) {
    leadSnapshot = await buildLeadSnapshot(effectiveLeadId);
  }

  const transactionResult = await runTransactionWithRetry(async (mongoSession) => {
    // 1. Consumir crédito reutilizável atomicamente (se for pacote sem pagamento)
    let creditContext = null;
    let reusedPayment = false;

    if (isNoAmountPackageSession && packageId) {
      creditContext = await claimReusableCredit(packageId, mongoSession);
      reusedPayment = !!creditContext;
    }

    // 2. Cria agendamento via HybridService (fonte de verdade)
    const hybridResult = await appointmentHybridService.create(
      {
        patientId: effectivePatientId,
        doctorId,
        date: payload.date,
        time: payload.time,
        specialty: payload.specialty,
        sessionType: payload.sessionType,
        serviceType,
        packageId,
        insuranceGuideId: payload.insuranceGuideId,
        billingType: payload.billingType || 'particular',
        paymentMethod,
        amount,
        forcePayment: false,
        notes: payload.notes,
        userId: user?._id,
        createdBy: user?._id,
        isJointSession: payload.isJointSession || false,
        // Contrato único dos campos simples do modal. Não usar `...payload`: campos
        // financeiros/lifecycle precisam continuar passando por regras explícitas.
        ...pickAppointmentClientFields(payload),
        // Agenda Externa é canal de PRIMEIRO CONTATO: o domínio força pre_agendado e
        // a promoção para scheduled só acontece via confirmPreAgendamentoCommand.
        // O front do CRM (bookingService / packageService) legitimamente cria já
        // 'scheduled' — sessão de pacote não é interesse, é agendamento fechado —
        // então a restrição é por contexto do chamador, não pelo endpoint.
        operationalStatus: isAgendaService ? 'pre_agendado' : payload.operationalStatus,
        patientInfo: effectivePatientSnapshot ? {
          fullName: effectivePatientSnapshot.fullName || effectivePatientSnapshot.name || '',
          phone: effectivePatientSnapshot.phone || '',
          birthDate: effectivePatientSnapshot.dateOfBirth || null,
          email: effectivePatientSnapshot.email || null,
        } : undefined,
      },
      mongoSession
    );

    // 3. Aplicar crédito reutilizável na sessão criada
    if (creditContext) {
      const sessionDoc = await Session.findById(hybridResult.sessionId).session(mongoSession);
      if (sessionDoc) {
        const credit = buildCreditApplication(
          { originalPaymentMethod: creditContext.paymentMethod },
          null,
          paymentMethod
        );
        sessionDoc.isPaid = credit.isPaid;
        sessionDoc.paymentStatus = credit.paymentStatus;
        sessionDoc.visualFlag = credit.visualFlag;
        sessionDoc.paymentMethod = credit.paymentMethod;
        sessionDoc.partialAmount = creditContext.partialAmount;
        sessionDoc._inFinancialTransaction = true;
        await sessionDoc.save({ session: mongoSession, validateBeforeSave: false });

        // Atualiza appointment para refletir pagamento
        await Appointment.findByIdAndUpdate(
          hybridResult.appointmentId,
          {
            $set: {
              paymentStatus: credit.paymentStatus,
              paymentMethod: credit.paymentMethod,
              visualFlag: credit.visualFlag,
            },
          },
          {
            session: mongoSession,
            __fromFinancialGuard: true,
            __guardContext: 'FINANCIAL',
          }
        );
      }
    }

    // 4. Vincula lead ao appointment (dentro da transação, mas lead já existe fora)
    if (effectiveLeadId && leadSnapshot) {
      await Appointment.findByIdAndUpdate(
        hybridResult.appointmentId,
        {
          $set: {
            lead: effectiveLeadId,
            leadSnapshot,
          },
        },
        {
          session: mongoSession,
          __fromFinancialGuard: true,
          __guardContext: 'FINANCIAL',
        }
      );
    }

    // 5. Atualiza Patient.appointments
    await Patient.findByIdAndUpdate(
      effectivePatientId,
      { $addToSet: { appointments: hybridResult.appointmentId } },
      { session: mongoSession, new: false }
    );

    return {
      hybridResult,
      reusedPayment,
    };
  });

  const { hybridResult, reusedPayment } = transactionResult;
  const PaymentModel = (await import('../../../models/Payment.js')).default;

  // As três consultas são independentes e acontecem somente após o commit
  // gerenciado por runTransactionWithRetry.
  const [populatedAppointment, populatedSession, populatedPayment] = await Promise.all([
    Appointment.findById(hybridResult.appointmentId)
      .populate('patient doctor session payment package')
      .lean(),
    hybridResult.sessionId
      ? Session.findById(hybridResult.sessionId).lean()
      : Promise.resolve(null),
    hybridResult.paymentId
      ? PaymentModel.findById(hybridResult.paymentId).lean()
      : Promise.resolve(null),
  ]);

  if (!populatedAppointment) {
    throw buildError('Agendamento criado, mas não encontrado após o commit', 500, 'CREATED_APPOINTMENT_NOT_FOUND');
  }

  // Socket e auditoria são independentes. A auditoria já é best-effort e o
  // helper de socket nunca propaga erro; executá-los juntos reduz a latência.
  await Promise.all([
    emitSocket('appointmentCreated', {
      _id: hybridResult.appointmentId,
      patient: effectivePatientId,
      doctor: doctorId,
      date: payload.date,
      time: payload.time,
      specialty: payload.specialty,
      source: isPackageSession ? 'crm_package_session' : 'crm_individual',
    }),
    recordAudit({
      user,
      action: 'appointment_created',
      entityType: 'Appointment',
      entityId: populatedAppointment._id,
      before: null,
      after: populatedAppointment,
      source: 'appointment_command:createAppointmentCommand:hybrid',
      correlationId: populatedAppointment.correlationId,
    }),
  ]);

  return {
    appointment: populatedAppointment,
    session: populatedSession,
    payment: populatedPayment,
    data: populatedAppointment,
    message: isNoAmountPackageSession
      ? reusedPayment
        ? 'Sessão de pacote agendada reaproveitando pagamento anterior'
        : 'Sessão de pacote agendada com sucesso'
      : hybridResult.message || 'Agendamento criado',
    reusedPayment,
  };
}

export default { execute };
