import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Doctor from '../../models/Doctor.js';
import TherapeuticPlan from '../../models/TherapeuticPlan.js';
import LiminarContract from '../../models/LiminarContract.js';
import { buildDateTime, buildDayRange } from '../../utils/datetime.js';
import { buildLiminarSession } from '../../domain/session/sessionFactory.js';
import { normalizeCancellations, classifyExistingCancellation, cancellationError } from './historicalCancellationRules.js';

// Manual historical entry only. No Payment, credit operation, outbox or notification.
export async function recordHistoricalCancellations({ contractId, planId, cancellations, dryRun, user, mongoSession }) {
  const rows = normalizeCancellations(cancellations);
  const actor = user?.id || user?._id;
  if (!mongoose.isValidObjectId(actor)) throw cancellationError('Usuário autenticado inválido.', 401);
  if (![contractId, planId].every(x => mongoose.isValidObjectId(x))) throw cancellationError('Contrato ou plano inválido.');
  if (typeof dryRun !== 'boolean') throw cancellationError('Informe dryRun como booleano.');
  const session = mongoSession || await mongoose.startSession();
  let result;
  try {
    const execute = async () => {
      const plan = await TherapeuticPlan.findOne({ _id: planId, liminarContract: contractId }).session(session).lean();
      const contract = await LiminarContract.findById(contractId).session(session).lean();
      if (!plan || !contract || String(plan.patient) !== String(contract.patient)) throw cancellationError('Plano e contrato incompatíveis.', 404);
      const therapies = plan.therapies instanceof Map ? Object.fromEntries(plan.therapies) : plan.therapies || {};
      const decisions = [];
      for (const row of rows) {
        if (!Object.hasOwn(therapies, row.specialty)) throw cancellationError('Especialidade não pertence ao plano.');
        const doctor = await Doctor.findById(row.doctorId).select('_id specialty clinicId tenantId').session(session).lean();
        if (!doctor) throw cancellationError('Profissional não encontrado.');
        for (const field of ['clinicId', 'tenantId']) {
          if (contract[field] && doctor[field] && String(contract[field]) !== String(doctor[field])) throw cancellationError('Profissional de outra clínica.', 403);
        }
        const existing = await Appointment.find({ patient: contract.patient, time: row.time,
          $or: [{ date: buildDayRange(row.date) }, { date: new Date(`${row.date}T00:00:00Z`) }] })
          .select('_id operationalStatus liminarContract specialty doctor').session(session).lean();
        decisions.push({ ...row, ...classifyExistingCancellation(row, existing, contractId) });
      }
      const conflicts = decisions.filter(d => d.action === 'conflict');
      result = { dryRun, created: 0, preserved: decisions.filter(d => d.action === 'preserve').length, conflicts, decisions };
      // All-or-nothing; return conflicts for the reception to resolve, without changing clinical records.
      if (dryRun || conflicts.length) return;
      // Serialize concurrent applications, including records excluded from active-slot indexes.
      if (decisions.some(d => d.action === 'create')) await TherapeuticPlan.updateOne({ _id: plan._id }, { $inc: { __v: 1 } }, { session });
      for (const row of decisions.filter(d => d.action === 'create')) {
        const now = new Date();
        const [appointment] = await Appointment.insertMany([{
          patient: contract.patient, doctor: row.doctorId, date: buildDateTime(row.date, row.time), time: row.time,
          specialty: row.specialty, sessionType: row.specialty, sessionValue: row.sessionValue,
          serviceType: 'liminar_session', billingType: 'liminar', paymentMethod: 'liminar_credit', paymentOrigin: 'liminar_credit',
          liminarContract: contract._id, therapeuticPlan: plan._id, planVersion: plan.version,
          operationalStatus: 'canceled', clinicalStatus: 'pending', paymentStatus: 'canceled', visualFlag: 'blocked',
          cancelReason: row.reason, cancelRequester: row.cancelRequester, cancelRequestedAt: row.cancelRequestedAt,
          canceledAt: now, canceledBy: actor,
          history: [{ action: 'cancelamento', newStatus: 'canceled', changedBy: actor, timestamp: now, context: 'operacional',
            details: { historicalCancellation: true, reason: row.reason, cancelRequester: row.cancelRequester,
              cancelRequestedAt: row.cancelRequestedAt, attendanceDate: row.date, enteredAt: now } }],
          ...(contract.clinicId ? { clinicId: contract.clinicId } : {}),
        }], { session, ordered: true });
        const [clinicalSession] = await Session.insertMany([buildLiminarSession(appointment, {
          status: 'canceled', paymentStatus: 'canceled', visualFlag: 'blocked',
          notes: 'Cancelamento histórico informado manualmente; não comprova realização, pagamento ou consumo de crédito.',
        })], { session, ordered: true });
        await Appointment.updateOne({ _id: appointment._id }, { $set: { session: clinicalSession._id } }, { session });
        row.appointmentId = String(appointment._id);
        row.sessionId = String(clinicalSession._id);
        result.created++;
      }
    };
    if (mongoSession) await execute(); else await session.withTransaction(execute);
    return result;
  } finally { if (!mongoSession) await session.endSession(); }
}
