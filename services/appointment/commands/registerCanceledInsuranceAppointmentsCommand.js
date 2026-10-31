import mongoose from 'mongoose';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import Doctor from '../../../models/Doctor.js';
import InsurancePlan from '../../../models/InsurancePlan.js';
import InsuranceGuide from '../../../models/InsuranceGuide.js';
import Payment from '../../../models/Payment.js';
import InsuranceBatch from '../../../models/InsuranceBatch.js';
import { isPaymentFinanciallyReversible } from '../../../domain/payment/isPaymentFinanciallyReversible.js';
import { executeWithSession as cancelAppointment } from './cancelAppointmentCommand.js';
import { buildInsuranceSession } from '../../../domain/session/sessionFactory.js';
import { buildDateTime, buildDayRange } from '../../../utils/datetime.js';
import { normalizeCancellations, classifyExistingCancellation, cancellationError } from '../../../domain/appointment/historicalCancellationRules.js';

/** Creates missing canceled occurrences or cancels existing pending ones; never reverses completion. */
export async function registerCanceledInsuranceAppointments({ planId, cancellations, dryRun, user, mongoSession }) {
  const actor = user?.id || user?._id;
  if (!mongoose.isValidObjectId(actor)) throw cancellationError('Autenticação necessária.', 401);
  if (!['admin', 'superadmin', 'secretary'].includes(String(user.role).toLowerCase())) throw cancellationError('Sem permissão para registrar cancelamentos.', 403);
  if (!mongoose.isValidObjectId(planId) || typeof dryRun !== 'boolean') throw cancellationError('Plano ou opção de conferência inválidos.');
  const rows = normalizeCancellations(cancellations);
  const session = mongoSession || await mongoose.startSession();
  let result;
  try {
    const execute = async () => {
      const plan = await InsurancePlan.findById(planId).session(session).lean();
      if (!plan) throw cancellationError('Plano não encontrado.', 404);
      const guide = await InsuranceGuide.findById(plan.guide).session(session).lean();
      if (!guide || String(guide.patientId) !== String(plan.patient) || guide.specialty !== plan.specialty) throw cancellationError('Guia, paciente e plano incompatíveis.', 409);
      const decisions = [];
      for (const row of rows) {
        if (row.specialty !== plan.specialty) throw cancellationError('Especialidade diferente da guia.');
        const doctor = await Doctor.findById(row.doctorId).select('_id clinicId tenantId').session(session).lean();
        if (!doctor) throw cancellationError('Profissional não encontrado.');
        for (const field of ['clinicId', 'tenantId']) {
          if (guide[field] && doctor[field] && String(guide[field]) !== String(doctor[field])) throw cancellationError('Profissional de outra clínica.', 403);
        }
        const query = { patient: plan.patient, time: row.time, $or: [{ date: buildDayRange(row.date) }, { date: new Date(`${row.date}T00:00:00Z`) }] };
        const existing = await Appointment.find(query).select('_id operationalStatus clinicalStatus insuranceGuide insurancePlan specialty doctor session payment').session(session).lean();
        const decision = classifyExistingCancellation(row, existing, guide._id, 'insuranceGuide', { allowPending: true });
        if (['cancel', 'preserve'].includes(decision.action) && existing[0].insurancePlan && String(existing[0].insurancePlan) !== String(plan._id)) {
          Object.assign(decision, { action: 'conflict', code: 'CANCELLATION_PLAN_MISMATCH', message: 'O atendimento pertence a outro plano. Confira o vínculo antes de cancelar.' });
        }
        if (decision.action === 'cancel') {
          const appointment = existing[0];
          const linkedSessions = await Session.find({ $or: [
            { appointmentId: appointment._id }, ...(appointment.session ? [{ _id: appointment.session }] : []),
          ] }).session(session).lean();
          const sessionIds = linkedSessions.map(s => s._id);
          const payments = await Payment.find({ $or: [
            { appointment: appointment._id }, { appointmentId: String(appointment._id) },
            ...(appointment.payment ? [{ _id: appointment.payment }] : []),
            ...(sessionIds.length ? [{ session: { $in: sessionIds } }] : []),
          ] }).session(session).lean();
          const batch = await InsuranceBatch.findOne({ status: { $nin: ['canceled', 'cancelled'] }, $or: [
            { 'sessions.appointment': appointment._id },
            ...(sessionIds.length ? [{ 'sessions.session': { $in: sessionIds } }] : []),
            ...(payments.length ? [{ 'sessions.payment': { $in: payments.map(p => p._id) } }] : []),
          ] }).select('_id').session(session).lean();
          const inconsistentSession = linkedSessions.length !== 1 || !appointment.session
            || String(linkedSessions[0]?._id) !== String(appointment.session)
            || String(linkedSessions[0]?.appointmentId) !== String(appointment._id)
            || linkedSessions.some(s => s.status === 'completed' || s.guideConsumed || s.sessionConsumed
              || String(s.patient) !== String(plan.patient) || String(s.doctor) !== row.doctorId
              || String(s.insuranceGuide) !== String(guide._id));
          if (linkedSessions.some(s => s.status === 'completed' || s.guideConsumed || s.sessionConsumed)) {
            Object.assign(decision, { action: 'conflict', code: 'CONSUMED_SESSION_CANCELLATION_BLOCKED',
              message: 'Não é possível cancelar este atendimento: a sessão já foi concluída ou consumida. Solicite a correção administrativa antes de registrar o cancelamento.' });
          } else if (inconsistentSession || batch || payments.some(p => !isPaymentFinanciallyReversible(p))) {
            Object.assign(decision, { action: 'conflict', code: 'CANCELLATION_DEPENDENCY_BLOCKED',
              message: 'Há conclusão, consumo, vínculo inconsistente ou financeiro em andamento. Confira sessão e faturamento antes de cancelar.' });
          }
        }
        if (decision.action === 'create') {
          const orphan = await Session.findOne({ time: row.time, $and: [
            { $or: [{ patient: plan.patient }, { patientId: plan.patient }] }, { $or: query.$or },
          ] }).select('_id').session(session).lean();
          if (orphan) Object.assign(decision, { action: 'conflict', message: 'Há uma sessão nesse horário sem agendamento correspondente. Confira o vínculo antes de registrar outra.' });
        }
        decisions.push({ ...row, ...decision });
      }
      const conflicts = decisions.filter(d => d.action === 'conflict');
      result = { dryRun, created: 0, canceled: 0, preserved: decisions.filter(d => d.action === 'preserve').length, conflicts, decisions };
      if (dryRun || conflicts.length || !decisions.some(d => ['create', 'cancel'].includes(d.action))) return;
      // Serializes concurrent historical entries even though canceled slots have no unique active index.
      await InsurancePlan.updateOne({ _id: plan._id }, { $inc: { __v: 1 } }, { session });
      for (const row of decisions.filter(d => d.action === 'cancel')) {
        const canceled = await cancelAppointment(row.appointmentId, {
          reason: row.reason, cancelRequester: row.cancelRequester, cancelRequestedAt: row.cancelRequestedAt,
          cancelSource: row.cancelRequester === 'patient' ? 'patient' : 'clinic',
          deferSideEffects: true,
        }, { ...user, _id: actor }, session);
        const historyIndex = canceled.history.length - 1;
        await Appointment.updateOne({ _id: canceled._id }, { $set: {
          cancelRequestedAt: row.cancelRequestedAt,
          [`history.${historyIndex}.details.historicalCancellation`]: true,
          [`history.${historyIndex}.details.attendanceDate`]: row.date,
          [`history.${historyIndex}.details.insuranceGuideId`]: String(guide._id),
        } }, { session });
        row.sessionId = String(canceled.session?._id || canceled.session);
        result.canceled++;
      }
      for (const row of decisions.filter(d => d.action === 'create')) {
        const now = new Date();
        const [appointment] = await Appointment.insertMany([{
          patient: plan.patient, doctor: row.doctorId, specialty: row.specialty, sessionType: row.specialty,
          date: buildDateTime(row.date, row.time), time: row.time, sessionValue: row.sessionValue,
          insuranceGuide: guide._id, insurancePlan: plan._id, insuranceProvider: guide.insurance,
          serviceType: 'session', billingType: 'convenio', paymentMethod: 'convenio', paymentOrigin: 'convenio',
          operationalStatus: 'canceled', clinicalStatus: 'pending', paymentStatus: 'canceled', visualFlag: 'blocked',
          cancelReason: row.reason, cancelRequester: row.cancelRequester, cancelRequestedAt: row.cancelRequestedAt,
          canceledAt: now, canceledBy: actor,
          history: [{ action: 'cancelamento', newStatus: 'canceled', timestamp: now, changedBy: actor, context: 'operacional',
            details: { historicalCancellation: true, reason: row.reason, cancelRequester: row.cancelRequester,
              cancelRequestedAt: row.cancelRequestedAt, attendanceDate: row.date, enteredAt: now, insuranceGuideId: String(guide._id) } }],
          ...(guide.clinicId ? { clinicId: guide.clinicId } : {}),
        }], { session, ordered: true });
        const [clinicalSession] = await Session.insertMany([buildInsuranceSession(appointment, {
          status: 'canceled', paymentStatus: 'canceled', isPaid: false, visualFlag: 'blocked', insuranceGuide: guide._id,
          notes: 'Cancelamento informado manualmente. Não comprova realização, consumo de guia ou faturamento.',
        })], { session, ordered: true });
        await Appointment.updateOne({ _id: appointment._id }, { $set: { session: clinicalSession._id } }, { session });
        await InsurancePlan.updateOne({ _id: plan._id }, { $addToSet: { generatedAppointments: appointment._id } }, { session });
        Object.assign(row, { appointmentId: String(appointment._id), sessionId: String(clinicalSession._id) });
        result.created++;
      }
    };
    if (mongoSession) await execute(); else await session.withTransaction(execute);
    return result;
  } finally { if (!mongoSession) await session.endSession(); }
}
