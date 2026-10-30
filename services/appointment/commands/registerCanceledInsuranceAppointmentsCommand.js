import mongoose from 'mongoose';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import Doctor from '../../../models/Doctor.js';
import InsurancePlan from '../../../models/InsurancePlan.js';
import InsuranceGuide from '../../../models/InsuranceGuide.js';
import { buildInsuranceSession } from '../../../domain/session/sessionFactory.js';
import { buildDateTime, buildDayRange } from '../../../utils/datetime.js';
import { normalizeCancellations, classifyExistingCancellation, cancellationError } from '../../../domain/appointment/historicalCancellationRules.js';

/** Records a missing canceled occurrence. Never completes, consumes or bills it. */
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
        const existing = await Appointment.find(query).select('_id operationalStatus insuranceGuide specialty doctor').session(session).lean();
        const decision = classifyExistingCancellation(row, existing, guide._id, 'insuranceGuide');
        if (decision.action === 'create') {
          const orphan = await Session.findOne({ time: row.time, $and: [
            { $or: [{ patient: plan.patient }, { patientId: plan.patient }] }, { $or: query.$or },
          ] }).select('_id').session(session).lean();
          if (orphan) Object.assign(decision, { action: 'conflict', message: 'Há uma sessão nesse horário sem agendamento correspondente. Confira o vínculo antes de registrar outra.' });
        }
        decisions.push({ ...row, ...decision });
      }
      const conflicts = decisions.filter(d => d.action === 'conflict');
      result = { dryRun, created: 0, preserved: decisions.filter(d => d.action === 'preserve').length, conflicts, decisions };
      if (dryRun || conflicts.length || !decisions.some(d => d.action === 'create')) return;
      // Serializes concurrent historical entries even though canceled slots have no unique active index.
      await InsurancePlan.updateOne({ _id: plan._id }, { $inc: { __v: 1 } }, { session });
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
