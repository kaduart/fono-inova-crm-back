import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../infrastructure/queue/queueConfig.js', () => ({
  getQueue: () => ({ add: vi.fn() }),
  queues: {},
  redisConnection: { status: 'ready', on: () => {} }
}));

vi.mock('../../services/syncService.js', () => ({ syncEvent: vi.fn() }));

let replSet;
let BillingSubmission;
let InsuranceBatch;
let InsuranceCommunication;
let FinancialLedger;
let Outbox;
let Session;
let Payment;
let service;

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  BillingSubmission = (await import('../../models/BillingSubmission.js')).default;
  InsuranceBatch = (await import('../../models/InsuranceBatch.js')).default;
  InsuranceCommunication = (await import('../../models/InsuranceCommunication.js')).default;
  FinancialLedger = (await import('../../models/FinancialLedger.js')).default;
  Outbox = (await import('../../infrastructure/outbox/OutboxModel.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  service = await import('../../services/billingSubmission/BillingSubmissionService.js');
  await Promise.all([
    BillingSubmission.syncIndexes(),
    InsuranceBatch.syncIndexes(),
    FinancialLedger.syncIndexes(),
    Outbox.syncIndexes()
  ]);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map(collection => collection.deleteMany({})));
});

async function seedScope() {
  const patientId = oid();
  const providerId = oid();
  const userId = oid();
  await mongoose.connection.collection('convenios').insertOne({
    _id: providerId,
    code: 'unimed-anapolis',
    name: 'Unimed Anápolis',
    active: true,
    sessionValue: 100
  });

  const guides = [
    { _id: oid(), number: 'GUIA-1', specialty: 'fonoaudiologia' },
    { _id: oid(), number: 'GUIA-2', specialty: 'psicologia' }
  ];
  await mongoose.connection.collection('insuranceguides').insertMany(guides.map(guide => ({
    ...guide,
    patientId,
    insurance: 'unimed-anapolis',
    totalSessions: 10,
    usedSessions: 1,
    sessionValue: 100,
    billingMode: 'per_guide',
    status: 'active',
    expiresAt: new Date('2026-12-31T12:00:00Z')
  })));

  const sessions = guides.map((guide, index) => ({
    _id: oid(),
    patient: patientId,
    doctor: oid(),
    appointmentId: oid(),
    insuranceGuide: guide._id,
    sessionType: guide.specialty,
    status: 'completed',
    date: new Date(`2026-08-${String(10 + index).padStart(2, '0')}T12:00:00Z`),
    billingBatchId: null
  }));
  await Session.collection.insertMany(sessions);

  const payments = sessions.map(session => ({
    _id: oid(),
    patient: patientId,
    appointment: session.appointmentId,
    session: session._id,
    amount: 100,
    paymentDate: session.date,
    paymentMethod: 'convenio',
    status: 'pending',
    billingType: 'convenio',
    kind: 'session_payment',
    insurance: {
      provider: 'unimed-anapolis',
      insuranceProvider: providerId,
      status: 'pending_billing',
      grossAmount: 100,
      netAmount: 100
    }
  }));
  await Payment.collection.insertMany(payments);

  const invoiceDocumentId = oid();
  await mongoose.connection.collection('patientdocuments').insertOne({
    _id: invoiceDocumentId,
    patientId,
    type: 'invoice',
    name: 'nf-5001.pdf',
    url: 'https://example.invalid/nf-5001.pdf',
    uploadedBy: userId
  });

  return { patientId, providerId, userId, sessions, payments, invoiceDocumentId };
}

describe('finalizeBillingSubmission — transação financeira V1', () => {
  it('aceita backlog clínico anterior na competência atual de faturamento', async () => {
    const seeded = await seedScope();
    await Session.updateOne(
      { _id: seeded.sessions[0]._id },
      { $set: { date: new Date('2026-02-27T12:00:00Z') } }
    );

    const submission = await service.createBillingSubmission({
      patientId: seeded.patientId,
      insuranceProviderId: seeded.providerId,
      billingCompetence: '2026-08',
      sessionIds: [seeded.sessions[0]._id],
      userId: seeded.userId
    });

    expect(submission.billingCompetence).toBe('2026-08');
    expect(submission.sessionIds.map(String)).toEqual([seeded.sessions[0]._id.toString()]);
  });

  it('bloqueia sem NF e, após completar o draft, cria um lote agrupado para duas guias', async () => {
    const seeded = await seedScope();
    const submission = await service.createBillingSubmission({
      patientId: seeded.patientId,
      insuranceProviderId: seeded.providerId,
      billingCompetence: '2026-08',
      sessionIds: seeded.sessions.map(session => session._id),
      userId: seeded.userId
    });

    await expect(service.finalizeBillingSubmission(submission._id, { userId: seeded.userId }))
      .rejects.toMatchObject({ code: 'BILLING_SUBMISSION_INVOICE_REQUIRED' });
    expect(await InsuranceBatch.countDocuments()).toBe(0);
    expect(await Payment.countDocuments({ status: 'billed' })).toBe(0);

    const allocation = submission.billingAllocations[0];
    await service.updateBillingSubmission(submission._id, {
      billingAllocations: [{
        _id: allocation._id,
        sessionIds: seeded.sessions.map(session => session._id),
        invoice: {
          invoiceNumber: '5001',
          invoiceDate: '2026-08-20',
          documentId: seeded.invoiceDocumentId
        }
      }],
      expectedVersion: submission.__v,
      userId: seeded.userId
    });

    const result = await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });
    expect(result.submission.status).toBe('finalized');
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toMatchObject({
      invoiceNumber: '5001',
      insuranceProvider: 'unimed-anapolis',
      totalSessions: 2,
      totalGross: 200,
      status: 'sent'
    });
    expect(new Set(result.batches[0].sessions.map(item => item.guide.toString())).size).toBe(2);
    expect(await Session.countDocuments({ billingBatchId: result.batches[0]._id })).toBe(2);
    expect(await Payment.countDocuments({ status: 'billed', 'insurance.status': 'billed' })).toBe(2);
    expect(await FinancialLedger.countDocuments({ type: 'insurance_billed' })).toBe(2);
    expect(await Outbox.countDocuments({ eventType: 'PAYMENT_STATUS_CHANGED' })).toBe(2);
    expect(await Outbox.countDocuments({ eventType: 'INSURANCE_BATCH_SENT' })).toBe(1);

    const retry = await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });
    expect(retry.idempotent).toBe(true);
    expect(await InsuranceBatch.countDocuments()).toBe(1);
    expect(await FinancialLedger.countDocuments({ type: 'insurance_billed' })).toBe(2);
  });

  it('aplica documentação somente às sessões selecionadas no submission', async () => {
    const seeded = await seedScope();
    const submission = await service.createBillingSubmission({
      patientId: seeded.patientId,
      insuranceProviderId: seeded.providerId,
      billingCompetence: '2026-08',
      sessionIds: [seeded.sessions[0]._id],
      userId: seeded.userId
    });

    await InsuranceCommunication.create({
      billingSubmissionId: submission._id,
      billingAllocationIds: submission.billingAllocations.map(allocation => allocation._id),
      patientId: seeded.patientId,
      insuranceProvider: 'unimed-anapolis',
      purpose: 'billing',
      status: 'sent',
      sentAt: new Date('2026-08-20T12:00:00Z'),
      createdBy: seeded.userId
    });

    const { getInsuranceGuidesView } = await import('../../services/insuranceGuide/insuranceGuidesReadView.js');
    const view = await getInsuranceGuidesView({
      insurance: 'unimed-anapolis',
      patientId: seeded.patientId.toString()
    });
    const firstGuide = view.guides.find(guide => guide.guideId === seeded.sessions[0].insuranceGuide.toString());
    const secondGuide = view.guides.find(guide => guide.guideId === seeded.sessions[1].insuranceGuide.toString());

    expect(firstGuide.sessionDetails[0].phase).toBe('documentationSent');
    expect(secondGuide.sessionDetails[0].phase).toBe('pendingBilling');
  });
});
