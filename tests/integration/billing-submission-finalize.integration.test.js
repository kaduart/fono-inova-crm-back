import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
let paymentStatusService;
let financialLedgerService;
let billingSubmissionController;

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
  paymentStatusService = await import('../../services/paymentStatusService.js');
  financialLedgerService = await import('../../services/financialLedgerService.js');
  billingSubmissionController = await import('../../controllers/billingSubmissionController.js');
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

async function seedScope({ sessionCount = 2 } = {}) {
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

  // Uma guia por sessão mantém o cenário original (2 guias distintas no mesmo
  // lote) e escala para os testes de volume sem estourar limite de sessões/guia.
  const specialties = ['fonoaudiologia', 'psicologia'];
  const guides = Array.from({ length: sessionCount }, (_, index) => ({
    _id: oid(),
    number: `GUIA-${index + 1}`,
    specialty: specialties[index % specialties.length]
  }));
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

  const baseDate = Date.UTC(2026, 7, 10, 12, 0, 0);
  const sessions = guides.map((guide, index) => ({
    _id: oid(),
    patient: patientId,
    doctor: oid(),
    appointmentId: oid(),
    insuranceGuide: guide._id,
    sessionType: guide.specialty,
    status: 'completed',
    date: new Date(baseDate + index * 86_400_000),
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

describe('paridade da transição individual e em lote', () => {
  it('produz o mesmo estado financeiro observável em Payment, ledger e Outbox', async () => {
    const seeded = await seedScope({ sessionCount: 2 });
    const [individual, batch] = await Promise.all(
      seeded.payments.map(payment => Payment.findById(payment._id).lean())
    );
    const now = new Date('2026-08-13T18:00:00.000Z');

    await paymentStatusService.transitionPaymentStatus(individual._id, 'billed', {
      reason: 'billing_submission_finalized',
      userId: seeded.userId
    });
    await financialLedgerService.recordInsuranceBilled(individual, {
      userId: seeded.userId,
      correlationId: `parity_${individual._id}`,
      billedAt: now
    });

    const batchLedger = {
      type: 'insurance_billed', direction: 'credit', amount: batch.insurance.grossAmount,
      billingType: 'convenio', patient: batch.patient, appointment: batch.appointment,
      session: batch.session, payment: batch._id, correlationId: `parity_${batch._id}`,
      description: `Convênio faturado - ${batch.insurance.provider}`,
      occurredAt: now, createdBy: seeded.userId,
      metadata: { source: 'insurance_billing', provider: batch.insurance.provider }
    };
    await paymentStatusService.transitionPaymentStatusBatch(
      [{ payment: batch, ledger: batchLedger }],
      'billed',
      { now, reason: 'billing_submission_finalized', userId: seeded.userId }
    );

    const [individualDoc, batchDoc] = await Promise.all([
      Payment.collection.findOne({ _id: individual._id }),
      Payment.collection.findOne({ _id: batch._id })
    ]);
    const paymentShape = payment => ({
      status: payment.status,
      insuranceStatus: payment.insurance.status,
      billedAtSource: payment.insurance.billedAtSource,
      netAmount: payment.insurance.netAmount,
      receivedAmount: payment.insurance.receivedAmount,
      issRate: payment.insurance.issRate,
      issAmount: payment.insurance.issAmount,
      splitMethods: payment.splitMethods,
      kind: payment.kind
    });
    expect(paymentShape(batchDoc)).toEqual(paymentShape(individualDoc));

    const [individualLedger, batchLedgerDoc] = await Promise.all([
      FinancialLedger.findOne({ payment: individual._id }).lean(),
      FinancialLedger.findOne({ payment: batch._id }).lean()
    ]);
    const ledgerShape = ledger => ({
      type: ledger.type, direction: ledger.direction, amount: ledger.amount,
      billingType: ledger.billingType, source: ledger.metadata.source,
      provider: ledger.metadata.provider
    });
    expect(ledgerShape(batchLedgerDoc)).toEqual(ledgerShape(individualLedger));

    const [individualEvent, batchEvent] = await Promise.all([
      Outbox.findOne({ aggregateId: String(individual._id) }).lean(),
      Outbox.findOne({ aggregateId: String(batch._id) }).lean()
    ]);
    const eventShape = event => ({
      eventType: event.eventType, aggregateType: event.aggregateType,
      from: event.payload.from, to: event.payload.to, amount: event.payload.amount,
      kind: event.payload.kind, billingType: event.payload.billingType,
      reason: event.payload.reason
    });
    expect(eventShape(batchEvent)).toEqual(eventShape(individualEvent));
  });
});

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

// ═══════════════════════════════════════════════════════════════════════════
// Finalização em lote — o loop sequencial por Payment (4 round-trips cada)
// estourava o timeout do cliente. O cliente desistia, o backend commitava e a
// interface anunciava falha para uma operação concluída.
// ═══════════════════════════════════════════════════════════════════════════

async function createFinalizableSubmission(seeded, sessionIds = seeded.sessions.map(session => session._id)) {
  const submission = await service.createBillingSubmission({
    patientId: seeded.patientId,
    insuranceProviderId: seeded.providerId,
    billingCompetence: '2026-08',
    sessionIds,
    userId: seeded.userId
  });
  const allocation = submission.billingAllocations[0];
  await service.updateBillingSubmission(submission._id, {
    billingAllocations: [{
      _id: allocation._id,
      sessionIds,
      invoice: {
        invoiceNumber: '5001',
        invoiceDate: '2026-08-20',
        documentId: seeded.invoiceDocumentId
      }
    }],
    expectedVersion: submission.__v,
    userId: seeded.userId
  });
  return submission;
}

async function countAll() {
  const [batches, billed, ledger, outbox, linked, communications] = await Promise.all([
    InsuranceBatch.countDocuments(),
    Payment.countDocuments({ status: 'billed', 'insurance.status': 'billed' }),
    FinancialLedger.countDocuments({ type: 'insurance_billed' }),
    Outbox.countDocuments(),
    Session.countDocuments({ billingBatchId: { $ne: null } }),
    InsuranceCommunication.countDocuments()
  ]);
  return { batches, billed, ledger, outbox, linked, communications };
}

describe('finalizeBillingSubmission — escritas em lote', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('volume', () => {
    // A meta de latência é de produção (Render↔Atlas). Aqui o Mongo é in-memory
    // e o relógio não representa a rede, então o que se afirma é a propriedade
    // que PRODUZ a latência: número de round-trips constante em relação ao
    // número de sessões. O tempo vai junto só como evidência.
    for (const sessionCount of [1, 16, 100]) {
      it(`finaliza ${sessionCount} payment(s) com número constante de queries`, async () => {
        const seeded = await seedScope({ sessionCount });
        const submission = await createFinalizableSubmission(seeded);

        const startedAt = Date.now();
        const result = await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });
        const elapsed = Date.now() - startedAt;

        expect(result.submission.status).toBe('finalized');
        expect(result.instrumentation.payments).toBe(sessionCount);
        // 13 = load_submission + validate + provider + 3 (escopo) + batches +
        // sessions + payments + ledger + dedupe + outbox + save_submission.
        // O número é EXATO de propósito: é ele que garante que a latência parou
        // de crescer com o volume. Se subir junto com sessionCount, alguma
        // escrita voltou para dentro de um loop.
        expect(result.instrumentation.queries).toBe(13);

        const counts = await countAll();
        expect(counts.billed).toBe(sessionCount);
        expect(counts.ledger).toBe(sessionCount);
        expect(counts.linked).toBe(sessionCount);
        expect(counts.batches).toBe(1);
        // 1 evento por payment + 1 do lote
        expect(counts.outbox).toBe(sessionCount + 1);

        console.log(`[perf] ${sessionCount} sessões: ${elapsed}ms, ${result.instrumentation.queries} queries`);
      }, 60_000);
    }
  });

  describe('rollback integral do núcleo financeiro', () => {
    it('falha no meio das atualizações de Payment desfaz tudo', async () => {
      const seeded = await seedScope({ sessionCount: 4 });
      const submission = await createFinalizableSubmission(seeded);

      // Simula um Payment que mudou de status por fora entre a validação e a
      // escrita: o filtro do updateOne não casa e o modifiedCount não fecha.
      vi.spyOn(Payment, 'bulkWrite').mockResolvedValueOnce({ modifiedCount: 2 });

      await expect(service.finalizeBillingSubmission(submission._id, { userId: seeded.userId }))
        .rejects.toMatchObject({ code: 'BILLING_SUBMISSION_PAYMENT_CONCURRENT_CHANGE' });

      expect(await countAll()).toMatchObject({
        batches: 0, billed: 0, ledger: 0, outbox: 0, linked: 0
      });
      const reloaded = await BillingSubmission.findById(submission._id).lean();
      expect(reloaded.status).toBe('draft');
    });

    // O conflito de escrita concorrente vem de dentro do serviço canônico
    // (paymentStatusService.js) como PaymentBatchTransitionError — uma classe que
    // não é BillingSubmissionError e não carrega status HTTP, de propósito: o
    // serviço canônico não deve saber o que é um status code. Sem a tradução na
    // camada de billing, o controller caía no branch genérico do sendError() e
    // devolvia 500 para um conflito que sempre foi 409 na versão sequencial
    // (antes da extração para transitionPaymentStatusBatch).
    it('conflito concorrente preserva 409 no contrato HTTP, não regride para 500', async () => {
      const seeded = await seedScope({ sessionCount: 2 });
      const submission = await createFinalizableSubmission(seeded);

      vi.spyOn(Payment, 'bulkWrite').mockResolvedValueOnce({ modifiedCount: 1 });

      const req = { params: { id: submission._id.toString() }, user: { id: seeded.userId.toString() } };
      const jsonMock = vi.fn();
      const statusMock = vi.fn(() => ({ json: jsonMock }));
      const res = { status: statusMock };

      await billingSubmissionController.finalize(req, res);

      expect(statusMock).toHaveBeenCalledWith(409);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        code: 'BILLING_SUBMISSION_PAYMENT_CONCURRENT_CHANGE',
        message: 'Um Payment mudou de status durante a transição em lote',
        details: { expected: 2, modified: 1 }
      });

      // A tradução HTTP não deve enfraquecer o rollback: nada persistido.
      expect(await countAll()).toMatchObject({
        batches: 0, billed: 0, ledger: 0, outbox: 0, linked: 0
      });
      expect((await BillingSubmission.findById(submission._id).lean()).status).toBe('draft');
    });

    it('falha no ledger desfaz o faturamento inteiro', async () => {
      const seeded = await seedScope({ sessionCount: 3 });
      const submission = await createFinalizableSubmission(seeded);

      vi.spyOn(FinancialLedger, 'insertMany').mockRejectedValueOnce(new Error('ledger indisponível'));

      await expect(service.finalizeBillingSubmission(submission._id, { userId: seeded.userId }))
        .rejects.toThrowError(/ledger indisponível/);

      expect(await countAll()).toMatchObject({
        batches: 0, billed: 0, ledger: 0, outbox: 0, linked: 0
      });
      expect((await BillingSubmission.findById(submission._id).lean()).status).toBe('draft');
    });

    it('falha no Outbox desfaz o faturamento inteiro', async () => {
      const seeded = await seedScope({ sessionCount: 3 });
      const submission = await createFinalizableSubmission(seeded);

      vi.spyOn(Outbox, 'insertMany').mockRejectedValueOnce(new Error('outbox indisponível'));

      await expect(service.finalizeBillingSubmission(submission._id, { userId: seeded.userId }))
        .rejects.toThrowError(/outbox indisponível/);

      expect(await countAll()).toMatchObject({
        batches: 0, billed: 0, ledger: 0, outbox: 0, linked: 0
      });
      expect((await BillingSubmission.findById(submission._id).lean()).status).toBe('draft');
    });
  });

  describe('idempotência', () => {
    it('timeout do cliente depois do commit: o estado permanece íntegro e o retry é no-op', async () => {
      const seeded = await seedScope({ sessionCount: 5 });
      const submission = await createFinalizableSubmission(seeded);

      // O commit acontece independentemente de o cliente estar escutando —
      // desconexão de socket não cancela o handler nem a transação.
      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });
      const afterCommit = await countAll();
      expect(afterCommit).toMatchObject({ batches: 1, billed: 5, ledger: 5, linked: 5 });

      // É exatamente isto que confirmFinalizeOutcome faz no frontend ao receber
      // ECONNABORTED: relê o submission em vez de reportar erro.
      const confirmation = await service.getBillingSubmission(submission._id);
      expect(confirmation.submission.status).toBe('finalized');

      const retry = await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });
      expect(retry.idempotent).toBe(true);
      expect(await countAll()).toEqual(afterCommit);
    });

    it('retry com a mesma chave não duplica nada', async () => {
      const seeded = await seedScope({ sessionCount: 4 });
      const submission = await createFinalizableSubmission(seeded);

      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });
      const baseline = await countAll();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const retry = await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });
        expect(retry.idempotent).toBe(true);
      }

      expect(await countAll()).toEqual(baseline);
    });

    it('clique duplo: duas finalizações concorrentes produzem um único lote', async () => {
      const seeded = await seedScope({ sessionCount: 4 });
      const submission = await createFinalizableSubmission(seeded);

      const results = await Promise.allSettled([
        service.finalizeBillingSubmission(submission._id, { userId: seeded.userId }),
        service.finalizeBillingSubmission(submission._id, { userId: seeded.userId })
      ]);

      // Uma das duas pode perder por conflito de escrita; o que não pode é
      // qualquer registro nascer duas vezes.
      expect(results.some(result => result.status === 'fulfilled')).toBe(true);
      expect(await countAll()).toMatchObject({
        batches: 1, billed: 4, ledger: 4, linked: 4, outbox: 5
      });
    });
  });

  describe('separação entre faturamento e entrega', () => {
    it('envio externo é registrado na mesma transação', async () => {
      const seeded = await seedScope({ sessionCount: 3 });
      const submission = await createFinalizableSubmission(seeded);

      await service.finalizeBillingSubmission(submission._id, {
        userId: seeded.userId,
        externalDelivery: { reason: 'Protocolo 998877 entregue no portal do convênio' }
      });

      const communications = await InsuranceCommunication.find({ billingSubmissionId: submission._id }).lean();
      expect(communications).toHaveLength(1);
      expect(communications[0]).toMatchObject({
        deliveryMethod: 'external',
        status: 'sent',
        purpose: 'billing',
        statusReason: 'Protocolo 998877 entregue no portal do convênio'
      });
      expect(communications[0].sentAt).toBeInstanceOf(Date);
    });

    it('envio externo não duplica no retry', async () => {
      const seeded = await seedScope({ sessionCount: 2 });
      const submission = await createFinalizableSubmission(seeded);
      const externalDelivery = { reason: 'Entregue presencialmente' };

      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId, externalDelivery });
      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId, externalDelivery });

      expect(await InsuranceCommunication.countDocuments({ billingSubmissionId: submission._id })).toBe(1);
    });

    it('rollback do faturamento leva junto o registro de envio externo', async () => {
      const seeded = await seedScope({ sessionCount: 2 });
      const submission = await createFinalizableSubmission(seeded);

      vi.spyOn(Outbox, 'insertMany').mockRejectedValueOnce(new Error('outbox indisponível'));

      await expect(service.finalizeBillingSubmission(submission._id, {
        userId: seeded.userId,
        externalDelivery: { reason: 'Entregue presencialmente' }
      })).rejects.toThrowError(/outbox indisponível/);

      expect(await InsuranceCommunication.countDocuments()).toBe(0);
    });

    it('sem envio externo, a finalização não cria comunicação — e-mail é enfileirado depois do commit', async () => {
      const seeded = await seedScope({ sessionCount: 3 });
      const submission = await createFinalizableSubmission(seeded);

      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });

      expect(await InsuranceCommunication.countDocuments()).toBe(0);
      expect(await countAll()).toMatchObject({ batches: 1, billed: 3, ledger: 3 });
    });

    it('falha posterior no provedor de e-mail não desfaz o faturamento', async () => {
      const seeded = await seedScope({ sessionCount: 3 });
      const submission = await createFinalizableSubmission(seeded);

      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });
      const afterBilling = await countAll();

      // O envio vive fora da transação, num registro próprio, e pode falhar e
      // ser retentado sem tocar no financeiro já commitado.
      await InsuranceCommunication.create({
        billingSubmissionId: submission._id,
        patientId: seeded.patientId,
        insuranceProvider: 'unimed-anapolis',
        purpose: 'billing',
        status: 'draft',
        statusReason: 'SMTP recusou a conexão',
        deliveryMethod: 'email',
        createdBy: seeded.userId
      });

      const stillBilled = await countAll();
      expect(stillBilled.batches).toBe(afterBilling.batches);
      expect(stillBilled.billed).toBe(afterBilling.billed);
      expect(stillBilled.ledger).toBe(afterBilling.ledger);
      expect((await BillingSubmission.findById(submission._id).lean()).status).toBe('finalized');
    });
  });

  describe('invariantes dos hooks e write guard', () => {
    it('recusa e faz rollback quando um Payment do lote é consumo de pacote', async () => {
      const seeded = await seedScope({ sessionCount: 3 });
      const submission = await createFinalizableSubmission(seeded);

      // Bypass proposital dos hooks para simular dado corrompido em produção.
      await Payment.collection.updateOne(
        { _id: seeded.payments[1]._id },
        { $set: { isFromPackage: true } }
      );

      await expect(service.finalizeBillingSubmission(submission._id, { userId: seeded.userId }))
        .rejects.toMatchObject({ code: 'PAYMENT_IS_PACKAGE_CONSUMPTION' });

      expect(await countAll()).toMatchObject({ batches: 0, billed: 0, ledger: 0, linked: 0 });
    });

    it('reconstrói patientId ausente, como fazia o pre(validate)', async () => {
      const seeded = await seedScope({ sessionCount: 2 });
      const submission = await createFinalizableSubmission(seeded);

      await Payment.collection.updateOne(
        { _id: seeded.payments[0]._id },
        { $unset: { patientId: '' } }
      );

      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });

      const reloaded = await Payment.findById(seeded.payments[0]._id).lean();
      expect(reloaded.patientId).toBe(seeded.patientId.toString());
      expect(reloaded.status).toBe('billed');
    });

    it('infere kind ausente, como fazia o enforcement do pre(validate)', async () => {
      const seeded = await seedScope({ sessionCount: 2 });
      const submission = await createFinalizableSubmission(seeded);

      await Payment.collection.updateOne(
        { _id: seeded.payments[0]._id },
        { $unset: { kind: '' } }
      );

      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });

      const reloaded = await Payment.findById(seeded.payments[0]._id).lean();
      expect(reloaded.kind).toBe('session_payment');
      expect(reloaded.kindSource).toBe('inferred_on_billing');
    });

    it('não grava billedAt de topo — campo inexistente no schema, descartado pelo strict mode', async () => {
      const seeded = await seedScope({ sessionCount: 2 });
      const submission = await createFinalizableSubmission(seeded);

      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });

      const raw = await Payment.collection.findOne({ _id: seeded.payments[0]._id });
      expect(raw.billedAt).toBeUndefined();
      expect(raw.insurance.billedAt).toBeInstanceOf(Date);
      expect(raw.insurance.billedAtSource).toBe('paymentStatusService');
    });

    // Paridade com o .save(): os defaults do schema que o fluxo antigo gravava
    // no documento continuam sendo gravados pelo bulkWrite.
    it('materializa os defaults financeiros ausentes sem sobrescrever os preenchidos', async () => {
      const seeded = await seedScope({ sessionCount: 2 });
      const submission = await createFinalizableSubmission(seeded);

      // O seed já traz netAmount=100 e omite receivedAmount/issRate/issAmount.
      // No segundo payment, splitMethods vem preenchido para provar que um array
      // existente não é zerado.
      await Payment.collection.updateOne(
        { _id: seeded.payments[1]._id },
        { $set: { splitMethods: [{ method: 'pix', amount: 100 }], 'insurance.issRate': 5 } }
      );

      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });

      const first = await Payment.collection.findOne({ _id: seeded.payments[0]._id });
      expect(first.insurance.netAmount).toBe(100);   // preservado
      expect(first.insurance.receivedAmount).toBe(0); // default materializado
      expect(first.insurance.issRate).toBe(0);
      expect(first.insurance.issAmount).toBe(0);
      expect(first.splitMethods).toEqual([]);

      const second = await Payment.collection.findOne({ _id: seeded.payments[1]._id });
      expect(second.insurance.issRate).toBe(5);       // preservado
      expect(second.insurance.receivedAmount).toBe(0);
      expect(second.splitMethods).toEqual([{ method: 'pix', amount: 100 }]);
    });

    it('passa pelo AppointmentWriteGuard com contexto autorizado', async () => {
      const seeded = await seedScope({ sessionCount: 4 });
      const submission = await createFinalizableSubmission(seeded);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await service.finalizeBillingSubmission(submission._id, { userId: seeded.userId });

      const guardViolations = warnSpy.mock.calls
        .map(args => args.join(' '))
        .filter(line => line.includes('AppointmentWriteGuard') && line.includes('"model": "Payment"'));
      expect(guardViolations).toEqual([]);

      const raw = await Payment.collection.findOne({ _id: seeded.payments[0]._id });
      expect(raw._fromInsuranceOrchestrator).toBe(true);
    });
  });
});
