import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import { runTransactionWithRetry } from '../../utils/transactionRetry.js';
import { applyFinancialProtection } from '../appointment/policies/appointmentFinancialPolicy.js';
import { syncSessionFromAppointment } from '../appointmentSessionSyncService.js';
import { isPaymentFinanciallyReversible } from '../../domain/payment/isPaymentFinanciallyReversible.js';
import { checkSlotConflicts } from '../schedule/generateInsurancePlanSessions.js';
import { recordAudit } from '../auditLogService.js';

export async function updateGuideEvaluation(guide, payload, user) {
  if (!guide.evaluationSessionId) return;
  let audit;
  await runTransactionWithRetry(async mongoSession => {
    const appointment = await Appointment.findOne({ session: guide.evaluationSessionId, insuranceGuide: guide._id, serviceType: 'evaluation' }).session(mongoSession).lean();
    if (!appointment) throw Object.assign(new Error('Agendamento da avaliação não encontrado.'), { statusCode: 409, code: 'EVALUATION_NOT_FOUND' });
    const date = payload.evaluationDate ? new Date(`${payload.evaluationDate}T00:00:00-03:00`) : appointment.date;
    const time = payload.evaluationTime || appointment.time;
    if (Number.isNaN(new Date(date).getTime()) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Object.assign(new Error('Informe uma data e um horário válidos para a avaliação.'), { statusCode: 400, code: 'INVALID_EVALUATION_SCHEDULE' });
    const scheduleChanged = new Date(date).toISOString().substring(0, 10) !== new Date(appointment.date).toISOString().substring(0, 10) || time !== appointment.time;
    const valueChanged = payload.evaluationAmount !== undefined && Number(appointment.sessionValue) !== Number(guide.evaluationAmount);
    if (!scheduleChanged && !valueChanged) return;
    if (!['scheduled', 'pre_agendado'].includes(appointment.operationalStatus)) throw Object.assign(new Error('A avaliação já confirmada, realizada ou cancelada deve ser ajustada pelo agendamento.'), { statusCode: 409, code: 'EVALUATION_NOT_EDITABLE' });
    const payments = await Payment.find({ $or: [{ appointment: appointment._id }, { session: guide.evaluationSessionId }, ...(appointment.payment ? [{ _id: appointment.payment }] : [])] }).session(mongoSession).lean();
    if (valueChanged && !payments.every(isPaymentFinanciallyReversible)) throw Object.assign(new Error('O valor da avaliação já faturada ou recebida não pode ser alterado pela guia.'), { statusCode: 409, code: 'EVALUATION_FINANCIALLY_LOCKED' });
    if (scheduleChanged) await checkSlotConflicts({ slots: [{ dateStr: new Date(date).toISOString().substring(0, 10), time }], doctorId: appointment.doctor, patientId: appointment.patient, duration: appointment.duration || 40, mongoSession, excludeAppointmentIds: [appointment._id] });
    const update = applyFinancialProtection(appointment, {
      date, time, updatedAt: new Date(),
      ...(valueChanged ? { sessionValue: Number(guide.evaluationAmount), insuranceValue: Number(guide.evaluationAmount) } : {})
    });
    const updated = await Appointment.findByIdAndUpdate(appointment._id, { $set: update }, { new: true, session: mongoSession });
    await syncSessionFromAppointment(updated, mongoSession);
    await Payment.updateMany({ _id: { $in: payments.map(p => p._id) } }, { $set: { serviceDate: date, ...(valueChanged ? { 'insurance.grossAmount': Number(guide.evaluationAmount) } : {}) } }, { session: mongoSession });
    await guide.save({ session: mongoSession });
    audit = { userId: user?._id, actorRole: user?.role, action: 'update', entityType: 'Appointment', entityId: appointment._id, source: 'insurance_guide', before: appointment, after: updated.toObject() };
  });
  if (audit) await recordAudit(audit);
}
