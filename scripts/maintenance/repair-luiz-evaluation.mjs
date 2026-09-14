import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { writeFile, mkdir } from 'node:fs/promises';
import { applyFinancialProtection } from '../../services/appointment/policies/appointmentFinancialPolicy.js';
import { isPaymentFinanciallyReversible } from '../../domain/payment/isPaymentFinanciallyReversible.js';

dotenv.config({ path: new URL('../../.env', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), quiet: true });
const apply = process.argv.includes('--apply');
const restoreSchedule = process.argv.includes('--restore-schedule');
const id = value => new mongoose.Types.ObjectId(value);
const patientId = id('6aa19f0bf60694e5e0ca34ca');
const guideId = id('6aa1a0c2f60694e5e0ca3745');
const appointmentId = id('6aa1a0c3f60694e5e0ca3747');
const correlationId = 'repair-luiz-evaluation-16513883';
try {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const guide = await db.collection('insuranceguides').findOne({ _id: guideId, patientId });
  const appointment = await db.collection('appointments').findOne({ _id: appointmentId, patient: patientId, insuranceGuide: guideId, serviceType: 'evaluation' });
  if (!guide || !appointment || guide.number !== '16513883' || guide.evaluationAmount !== 250) throw new Error('Unexpected guide/evaluation; aborting');
  const session = await db.collection('sessions').findOne({ _id: guide.evaluationSessionId, appointmentId });
  const payments = await db.collection('payments').find({ appointment: appointmentId }).toArray();
  const plans = await db.collection('insuranceplans').find({ patient: patientId, guide: guideId }).toArray();
  if (!session || !['scheduled', 'pre_agendado'].includes(appointment.operationalStatus) || session.guideConsumed || session.status === 'completed' || payments.length !== 1 || !payments.every(p => p.status === 'pending' && isPaymentFinanciallyReversible(p))) throw new Error('Evaluation is not safely editable; aborting');
  const now = new Date();
  const appointmentSet = applyFinancialProtection(appointment, {
    sessionValue: guide.evaluationAmount, insuranceValue: guide.evaluationAmount,
    insuranceProvider: guide.insurance, insurancePlan: null, updatedAt: now,
    ...(restoreSchedule ? { date: new Date('2026-09-15T03:00:00Z'), time: '16:00', startDateTime: new Date('2026-09-15T19:00:00Z'), endDateTime: new Date('2026-09-15T19:40:00Z') } : {})
  });
  if (restoreSchedule) {
    const conflicts = await db.collection('appointments').find({ _id: { $ne: appointmentId }, $or: [{ patient: patientId }, { doctor: appointment.doctor }], date: { $gte: new Date('2026-09-15T00:00:00Z'), $lt: new Date('2026-09-16T03:00:00Z') }, operationalStatus: { $nin: ['canceled', 'cancelled', 'missed', 'suspended', 'discarded'] } }, { projection: { time: 1, duration: 1 } }).toArray();
    if (conflicts.some(a => { const [h, m] = a.time.split(':').map(Number); const start = h * 60 + m; return start < 1000 && start + (a.duration || 40) > 960; })) throw new Error('Conflicting appointment on 15/09 at 16h; aborting');
  }
  const before = {
    appointment: { _id: appointment._id, date: appointment.date, time: appointment.time, startDateTime: appointment.startDateTime, endDateTime: appointment.endDateTime, sessionValue: appointment.sessionValue, insuranceValue: appointment.insuranceValue, insuranceProvider: appointment.insuranceProvider, insurancePlan: appointment.insurancePlan, updatedAt: appointment.updatedAt },
    session: { _id: session._id, date: session.date, time: session.time, sessionValue: session.sessionValue, insurancePlan: session.insurancePlan, updatedAt: session.updatedAt },
    payment: { _id: payments[0]._id, insurance: payments[0].insurance, updatedAt: payments[0].updatedAt },
    plans: plans.map(p => ({ _id: p._id, generatedAppointments: p.generatedAppointments, updatedAt: p.updatedAt }))
  };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', before, after: appointmentSet, sessionValue: 250, grossAmount: 250, detachEvaluationFromPlan: true, dateRequiresConfirmation: !restoreSchedule }, null, 2));
  if (apply) {
    const folder = new URL('../../auditoria-output/', import.meta.url);
    await mkdir(folder, { recursive: true });
    await writeFile(new URL(`${correlationId}-${Date.now()}.json`, folder), JSON.stringify(before, null, 2));
    const transaction = await mongoose.startSession();
    try {
      await transaction.withTransaction(async () => {
        const result = await db.collection('appointments').updateOne({ _id: appointmentId, updatedAt: appointment.updatedAt, operationalStatus: appointment.operationalStatus }, { $set: appointmentSet }, { session: transaction });
        if (result.matchedCount !== 1) throw new Error('Appointment changed concurrently');
        const sessionResult = await db.collection('sessions').updateOne({ _id: session._id, updatedAt: session.updatedAt }, { $set: { sessionValue: 250, insurancePlan: null, updatedAt: now, ...(restoreSchedule ? { date: appointmentSet.date, time: appointmentSet.time } : {}) } }, { session: transaction });
        const paymentResult = await db.collection('payments').updateOne({ _id: payments[0]._id, updatedAt: payments[0].updatedAt, status: 'pending' }, { $set: { 'insurance.grossAmount': 250, updatedAt: now, ...(restoreSchedule ? { serviceDate: appointmentSet.date } : {}) } }, { session: transaction });
        if (sessionResult.matchedCount !== 1 || paymentResult.matchedCount !== 1) throw new Error('Financial records changed concurrently');
        for (const plan of plans) {
          const result = await db.collection('insuranceplans').updateOne({ _id: plan._id, updatedAt: plan.updatedAt }, { $pull: { generatedAppointments: appointmentId }, $set: { updatedAt: now } }, { session: transaction });
          if (result.matchedCount !== 1) throw new Error('Plan changed concurrently');
        }
        await db.collection('auditlogs').insertOne({ action: 'repair', entityType: 'Appointment', entityId: appointmentId, source: 'maintenance/repair-luiz-evaluation.mjs', correlationId, severity: 'WARNING', actorRole: 'maintenance', before, after: appointmentSet, metadata: { reason: 'Evaluation incorrectly included and repriced by therapy plan', userAuthorized: true }, createdAt: now }, { session: transaction });
      });
    } finally { await transaction.endSession(); }
    const verified = await db.collection('appointments').findOne({ _id: appointmentId }, { projection: { date: 1, time: 1, serviceType: 1, sessionValue: 1, insuranceValue: 1, insuranceProvider: 1, insurancePlan: 1 } });
    console.log(JSON.stringify({ applied: true, verified }, null, 2));
  }
} catch (error) {
  console.error(error.name, String(error.message).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]'));
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
