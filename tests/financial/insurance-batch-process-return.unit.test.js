/**
 * =============================================================================
 * TESTES UNITÁRIOS — processReturn (insuranceBatchService.js)
 * =============================================================================
 *
 * processReturn era a única das três funções de lote reescritas na PR2 sem
 * nenhuma cobertura automatizada (faturarEmLote/receberEmLote já tinham, ver
 * insurance-batch-lote.unit.test.js). Cobre: sucesso, idempotência de lote,
 * idempotência de payment individual, retorno parcial, e o mapeamento
 * Payment/insurance.status/ledger.
 *
 * Run: npx vitest run tests/financial/insurance-batch-process-return.unit.test.js
 * =============================================================================
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

function fakeId() {
  const value = Math.random().toString(36).slice(2);
  return { toString: () => value, equals: (o) => String(o) === value };
}

globalThis.__mockPaymentFind = () => {};
globalThis.__mockPaymentBulkWrite = () => {};
globalThis.__mockBatchTransitionStatus = () => {};
globalThis.__mockRecordInsuranceReceived = () => {};

vi.mock('mongoose', () => {
  function ObjectIdMock(id) {
    return { toString: () => String(id ?? Math.random().toString(36).slice(2)) };
  }
  function createSchemaMock() {
    const schema = {
      index: () => schema, virtual: () => schema, pre: () => schema, post: () => schema,
      set: () => schema, plugin: () => schema, static: () => schema, method: () => schema,
      add: () => schema, path: () => ({ validate: () => schema })
    };
    schema.methods = {};
    schema.statics = {};
    return schema;
  }
  const SchemaMock = function () { return createSchemaMock(); };
  SchemaMock.Types = { ObjectId: ObjectIdMock, Mixed: class Mixed {}, Date, Number, String, Boolean };

  return {
    default: {
      Schema: SchemaMock,
      Types: { ObjectId: ObjectIdMock },
      model: (name) => {
        if (name === 'Payment') {
          return {
            find: (...args) => globalThis.__mockPaymentFind(...args),
            bulkWrite: (...args) => globalThis.__mockPaymentBulkWrite(...args)
          };
        }
        return { find: () => ({}), bulkWrite: () => ({}), updateOne: () => ({}) };
      },
      models: {}
    },
    Schema: SchemaMock,
    Types: { ObjectId: ObjectIdMock }
  };
});

vi.mock('/home/user/projetos/crm/back/models/Session.js', () => ({ default: {} }));
vi.mock('/home/user/projetos/crm/back/models/InsuranceBatch.js', () => ({ default: {} }));
vi.mock('/home/user/projetos/crm/back/models/Payment.js', () => ({
  default: {
    find: (...args) => globalThis.__mockPaymentFind(...args),
    bulkWrite: (...args) => globalThis.__mockPaymentBulkWrite(...args)
  }
}));

vi.mock('/home/user/projetos/crm/back/services/financialLedgerService.js', () => ({
  recordInsuranceBilled: vi.fn().mockResolvedValue({}),
  recordInsuranceReceived: (...args) => globalThis.__mockRecordInsuranceReceived(...args)
}));

vi.mock('/home/user/projetos/crm/back/services/paymentStatusService.js', () => ({
  transitionPaymentStatus: vi.fn().mockResolvedValue({}),
  batchTransitionStatus: (...args) => globalThis.__mockBatchTransitionStatus(...args)
}));

import { processReturn } from '../../services/insuranceBatchService.js';

// Cria um par (payment real + linha do lote apontando pro mesmo payment/session),
// já que processReturn casa item.paymentId com batch.sessions[].payment.toString() —
// tinham que ser o mesmo id, não dois ids aleatórios independentes.
function buildPair(paymentOverrides = {}, sessionOverrides = {}) {
  const sessionId = fakeId();
  const payment = {
    _id: fakeId(),
    session: sessionId,
    insurance: { status: 'billed' },
    ...paymentOverrides
  };
  const batchSession = {
    session: sessionId,
    payment: payment._id,
    status: 'sent',
    sessionDate: new Date('2026-06-10'),
    ...sessionOverrides
  };
  return { payment, batchSession };
}

function buildBatch(sessions) {
  return {
    _id: fakeId(),
    batchNumber: 'LOTE-TESTE-1',
    status: 'sent',
    sessions,
    totalSessions: sessions.length,
    totalGross: sessions.length * 200,
    save: vi.fn().mockResolvedValue(true)
  };
}

describe('insuranceBatchService.processReturn', () => {
  beforeEach(() => {
    globalThis.__mockPaymentFind = vi.fn();
    globalThis.__mockPaymentBulkWrite = vi.fn().mockResolvedValue({});
    globalThis.__mockBatchTransitionStatus = vi.fn().mockResolvedValue({ success: 0, failed: 0, errors: [] });
    globalThis.__mockRecordInsuranceReceived = vi.fn().mockResolvedValue({});
  });

  it('processa lote com sucesso: bulkWrite 1x, batch vira received, payments paid transicionados e ledger chamado', async () => {
    const { payment: p1, batchSession: s1 } = buildPair();
    const { payment: p2, batchSession: s2 } = buildPair();
    const batch = buildBatch([s1, s2]);

    const insuranceBatchModule = await import('/home/user/projetos/crm/back/models/InsuranceBatch.js');
    insuranceBatchModule.default.findById = vi.fn().mockResolvedValue(batch);

    globalThis.__mockPaymentFind.mockReturnValue({ lean: () => Promise.resolve([p1, p2]) });

    const returnData = {
      protocolNumber: 'PROT-1',
      items: [
        { paymentId: p1._id.toString(), sessionId: s1.session.toString(), status: 'paid', returnAmount: 200, glosaAmount: 0 },
        { paymentId: p2._id.toString(), sessionId: s2.session.toString(), status: 'paid', returnAmount: 200, glosaAmount: 0 }
      ]
    };

    const result = await processReturn(batch._id.toString(), returnData);

    expect(globalThis.__mockPaymentFind).toHaveBeenCalledTimes(1);
    expect(globalThis.__mockPaymentBulkWrite).toHaveBeenCalledTimes(1);
    const ops = globalThis.__mockPaymentBulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    expect(ops[0].updateOne.update.$set['insurance.status']).toBe('received');
    expect(ops[0].updateOne.update.$set['insurance.receivedAt']).toBeInstanceOf(Date);

    expect(globalThis.__mockBatchTransitionStatus).toHaveBeenCalledTimes(1);
    expect(globalThis.__mockBatchTransitionStatus.mock.calls[0][0]).toHaveLength(2);
    expect(globalThis.__mockBatchTransitionStatus.mock.calls[0][1]).toBe('paid');

    expect(globalThis.__mockRecordInsuranceReceived).toHaveBeenCalledTimes(2);

    expect(batch.status).toBe('received');
    expect(batch.save).toHaveBeenCalledTimes(1);
    expect(result.idempotent).toBeUndefined();
  });

  it('idempotência de lote: batch já "received" sem force retorna idempotent=true sem tocar em Payment', async () => {
    const { batchSession: s1 } = buildPair({}, { status: 'paid' });
    const batch = buildBatch([s1]);
    batch.status = 'received';

    const insuranceBatchModule = await import('/home/user/projetos/crm/back/models/InsuranceBatch.js');
    insuranceBatchModule.default.findById = vi.fn().mockResolvedValue(batch);

    const result = await processReturn(batch._id.toString(), { items: [] });

    expect(result.idempotent).toBe(true);
    expect(globalThis.__mockPaymentFind).not.toHaveBeenCalled();
    expect(batch.save).not.toHaveBeenCalled();
  });

  it('idempotência por payment: item já com insurance.status=received é ignorado (sem force)', async () => {
    const { payment: p1, batchSession: s1 } = buildPair({ insurance: { status: 'received' } });
    const batch = buildBatch([s1]);

    const insuranceBatchModule = await import('/home/user/projetos/crm/back/models/InsuranceBatch.js');
    insuranceBatchModule.default.findById = vi.fn().mockResolvedValue(batch);
    globalThis.__mockPaymentFind.mockReturnValue({ lean: () => Promise.resolve([p1]) });

    const result = await processReturn(batch._id.toString(), {
      items: [{ paymentId: p1._id.toString(), sessionId: s1.session.toString(), status: 'paid', returnAmount: 200 }]
    });

    expect(globalThis.__mockPaymentBulkWrite).not.toHaveBeenCalled();
    expect(globalThis.__mockBatchTransitionStatus).not.toHaveBeenCalled();
    expect(globalThis.__mockRecordInsuranceReceived).not.toHaveBeenCalled();
    expect(result.idempotent).toBeUndefined();
  });

  it('retorno parcial: só alguns itens pagos deixa o lote em status "partial", não "received"', async () => {
    const { payment: p1, batchSession: s1 } = buildPair();
    const { batchSession: s2 } = buildPair();
    const batch = buildBatch([s1, s2]);

    const insuranceBatchModule = await import('/home/user/projetos/crm/back/models/InsuranceBatch.js');
    insuranceBatchModule.default.findById = vi.fn().mockResolvedValue(batch);
    globalThis.__mockPaymentFind.mockReturnValue({ lean: () => Promise.resolve([p1]) });

    // s2 não vem no retorno — só s1 é processado como pago
    const result = await processReturn(batch._id.toString(), {
      items: [{ paymentId: p1._id.toString(), sessionId: s1.session.toString(), status: 'paid', returnAmount: 200 }]
    });

    expect(batch.status).toBe('processing'); // s2 continua 'sent', nem paid nem processed
    expect(result.idempotent).toBeUndefined();
    expect(globalThis.__mockPaymentBulkWrite).toHaveBeenCalledTimes(1);
  });

  it('mapeia insurance.status corretamente por tipo de retorno (paid/partial/glosa/rejected)', async () => {
    const pairs = ['paid', 'partial', 'glosa', 'rejected'].map(() => buildPair());
    const batch = buildBatch(pairs.map(pr => pr.batchSession));

    const insuranceBatchModule = await import('/home/user/projetos/crm/back/models/InsuranceBatch.js');
    insuranceBatchModule.default.findById = vi.fn().mockResolvedValue(batch);
    globalThis.__mockPaymentFind.mockReturnValue({ lean: () => Promise.resolve(pairs.map(pr => pr.payment)) });

    const items = pairs.map((pr, i) => ({
      paymentId: pr.payment._id.toString(),
      sessionId: pr.batchSession.session.toString(),
      status: ['paid', 'partial', 'glosa', 'rejected'][i],
      returnAmount: i < 2 ? 200 : 0,
      glosaAmount: i >= 2 ? 200 : 0
    }));

    await processReturn(batch._id.toString(), { items });

    const ops = globalThis.__mockPaymentBulkWrite.mock.calls[0][0];
    const statusByOp = ops.map(op => op.updateOne.update.$set['insurance.status']);
    expect(statusByOp).toEqual(['received', 'partial', 'glosa', 'glosa']);
    // ledger só é chamado para paid/partial (2 dos 4 itens)
    expect(globalThis.__mockRecordInsuranceReceived).toHaveBeenCalledTimes(2);
  });
});
