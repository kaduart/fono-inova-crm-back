import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Package from '../../models/Package.js';
import Payment from '../../models/Payment.js';
import Outbox from '../../infrastructure/outbox/OutboxModel.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';
let mongo;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([Appointment.init(), Session.init(), Package.init(), Payment.init(), Outbox.init()]);
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const model of [Appointment, Session, Package, Payment, Outbox]) await model.collection.deleteMany({});
});
async function seed() {
  const patient = new mongoose.Types.ObjectId();
  const packageId = new mongoose.Types.ObjectId();
  const completed = new mongoose.Types.ObjectId();
  const remaining = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const futureSession = new mongoose.Types.ObjectId();
  await Package.collection.insertOne({ _id: packageId, patient, model: 'per_session', paymentType: 'per-session',
    type: 'therapy', status: 'active', totalValue: 640, sessionValue: 160, totalPaid: 0, balance: 640 });
  await Appointment.collection.insertMany([
    { _id: completed, patient, package: packageId, operationalStatus: 'completed', billingType: 'particular', session: sessionId },
    { _id: remaining, patient, package: packageId, operationalStatus: 'scheduled', billingType: 'particular', session: futureSession },
  ]);
  await Session.collection.insertMany([
    { _id: sessionId, patient, package: packageId, appointmentId: completed, status: 'completed' },
    { _id: futureSession, patient, package: packageId, appointmentId: remaining, status: 'scheduled' },
  ]);
  const payment = await Payment.create({ patient, appointment: completed, session: sessionId, amount: 160, status: 'pending',
    billingType: 'particular', paymentMethod: 'pix', kind: 'session_payment', paymentDate: new Date() });
  const futurePayment = await Payment.create({ patient, appointment: remaining, session: futureSession, amount: 160, status: 'pending',
    billingType: 'particular', paymentMethod: 'pix', kind: 'session_payment', paymentDate: new Date() });
  return { packageId, payment, futurePayment, completed, remaining, futureSession };
}
describe('transactional package settlement closure', () => {
  it('settles through the legacy Appointment link and cancels only the remaining session', async () => {
    const data = await seed();
    await transitionPaymentStatus(String(data.payment._id), 'paid', { reason: 'test_settlement', silent: true });
    const pkg = await Package.findById(data.packageId).lean();
    expect(pkg).toMatchObject({ totalValue: 640, totalPaid: 160, balance: 0, financialStatus: 'paid', status: 'canceled' });
    expect(pkg.settlementClosure.billableValue).toBe(160);
    expect((await Appointment.findById(data.completed)).operationalStatus).toBe('completed');
    expect((await Appointment.findById(data.remaining)).operationalStatus).toBe('canceled');
    expect((await Session.findById(data.futureSession)).status).toBe('canceled');
    expect((await Payment.findById(data.futurePayment._id)).status).toBe('canceled');
    const count = await Outbox.countDocuments({});
    expect(count).toBe(2);
    await transitionPaymentStatus(String(data.payment._id), 'paid', { reason: 'retry', silent: true });
    expect(await Outbox.countDocuments({})).toBe(count);
  });
  it('rolls back payment, cancellations and closure together when cancellation fails', async () => {
    const data = await seed();
    vi.spyOn(Session, 'updateMany').mockRejectedValueOnce(new Error('cancel failed'));
    await expect(transitionPaymentStatus(String(data.payment._id), 'paid', { reason: 'test_failure', silent: true })).rejects.toThrow('cancel failed');
    expect((await Payment.findById(data.payment._id)).status).toBe('pending');
    expect((await Payment.findById(data.futurePayment._id)).status).toBe('pending');
    expect((await Appointment.findById(data.remaining)).operationalStatus).toBe('scheduled');
    expect((await Package.findById(data.packageId)).status).toBe('active');
    expect(await Outbox.countDocuments({})).toBe(0);
  });
});
