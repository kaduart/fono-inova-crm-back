/**
 * =============================================================================
 * TESTES UNITÁRIOS — faturarEmLote / receberEmLote (ConvenioMetricsService)
 * =============================================================================
 *
 * Valida que as operações em lote de faturamento e recebimento de convênio
 * carregam os payments uma única vez e usam bulkWrite, evitando N+1 de find/save.
 *
 * Run: npx vitest run tests/financial/insurance-batch-lote.unit.test.js
 * =============================================================================
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

function createObjectId() {
  const value = Math.random().toString(36).slice(2);
  return value;
}

function createMockFind(result) {
  return () => {
    const chain = Promise.resolve(result);
    chain.populate = () => chain;
    chain.select = () => chain;
    chain.lean = () => chain;
    return chain;
  };
}

// Mocks globais para serem acessados pelo factory hoisted do vi.mock('mongoose').
// O vi.mock é içado antes das variáveis locais, então usamos globalThis para
// compartilhar as funções de assert entre o factory e os testes.
globalThis.__mockPaymentFind = () => {};
globalThis.__mockPaymentBulkWrite = () => {};
globalThis.__mockSessionBulkWrite = () => {};
globalThis.__mockConvenioFind = createMockFind([]);

vi.mock('mongoose', () => {
  function createObjectId() {
    return {
      toString: () => Math.random().toString(36).slice(2),
      equals: (other) => String(other) === String(other)
    };
  }

  function createSchemaMock() {
    const schema = {
      index: () => schema,
      virtual: () => schema,
      pre: () => schema,
      post: () => schema,
      set: () => schema,
      plugin: () => schema,
      static: () => schema,
      method: () => schema,
      add: () => schema,
      path: () => ({
        validate: () => schema
      })
    };
    schema.methods = {};
    schema.statics = {};
    return schema;
  }

  const SchemaMock = function () { return createSchemaMock(); };
  SchemaMock.Types = {
    ObjectId: createObjectId,
    Mixed: class Mixed {},
    Date: Date,
    Number: Number,
    String: String,
    Boolean: Boolean
  };

  return {
    default: {
      Schema: SchemaMock,
      Types: { ObjectId: createObjectId },
      model: (name) => {
        if (name === 'Payment') {
          return {
            find: (...args) => globalThis.__mockPaymentFind(...args),
            bulkWrite: (...args) => globalThis.__mockPaymentBulkWrite(...args)
          };
        }
        if (name === 'Session') {
          return {
            bulkWrite: (...args) => globalThis.__mockSessionBulkWrite(...args)
          };
        }
        if (name === 'Convenio') {
          return {
            find: (...args) => globalThis.__mockConvenioFind(...args)
          };
        }
        return { find: () => ({}), bulkWrite: () => ({}), updateOne: () => ({}) };
      },
      models: {}
    },
    Schema: SchemaMock,
    Types: { ObjectId: createObjectId }
  };
});

vi.mock('moment-timezone', () => ({
  default: {
    tz: (date, tz) => ({
      startOf: () => ({ toDate: () => new Date(`${date}T00:00:00.000Z`) }),
      endOf: () => ({ toDate: () => new Date(`${date}T23:59:59.000Z`) }),
      format: () => date,
      add: () => ({ startOf: () => ({ format: () => date, toDate: () => new Date() }) })
    }),
    default: {
      tz: (date, tz) => ({
        startOf: () => ({ toDate: () => new Date(`${date}T00:00:00.000Z`) }),
        endOf: () => ({ toDate: () => new Date(`${date}T23:59:59.000Z`) }),
        format: () => date
      })
    }
  }
}));

vi.mock('../../../models/Payment.js', () => ({
  default: {}
}));

vi.mock('/home/user/projetos/crm/back/models/Session.js', () => ({
  default: {}
}));

vi.mock('/home/user/projetos/crm/back/models/Package.js', () => ({
  default: {}
}));

vi.mock('/home/user/projetos/crm/back/models/InsuranceGuide.js', () => ({
  default: {}
}));

vi.mock('../../../models/Patient.js', () => ({
  default: {}
}));

vi.mock('../../../models/PatientsView.js', () => ({
  default: {}
}));

vi.mock('../../../utils/identityResolver.js', () => ({
  resolvePatientId: vi.fn()
}));

vi.mock('../../../infrastructure/outbox/outboxPattern.js', () => ({
  saveToOutbox: vi.fn().mockResolvedValue({})
}));

vi.mock('../../../infrastructure/queue/queueConfig.js', () => ({
  default: {}
}));

globalThis.__mockBatchTransitionStatus = () => {};

vi.mock('/home/user/projetos/crm/back/services/paymentStatusService.js', () => ({
  transitionPaymentStatus: () => Promise.resolve({}),
  batchTransitionStatus: (...args) => globalThis.__mockBatchTransitionStatus(...args)
}));

vi.mock('../../../services/guideLifecycle/GuideLifecycleService.js', () => ({
  GuideLifecycleService: {}
}));

import service from '../../../services/financial/ConvenioMetricsService.js';

function buildPayment(overrides = {}) {
  const id = createObjectId();
  const sessionId = overrides.session !== undefined ? overrides.session : createObjectId();
  return {
    _id: id,
    session: sessionId,
    amount: 200,
    billingType: 'convenio',
    paymentMethod: 'convenio',
    status: 'pending',
    patient: { _id: createObjectId(), fullName: 'Paciente Teste' },
    package: {
      insuranceProvider: 'Unimed',
      insuranceGrossAmount: 250,
      sessionValue: 200
    },
    insurance: {
      status: 'pending_billing',
      grossAmount: 250,
      billedAt: null,
      receivedAt: null,
      receivedAmount: null,
      invoiceNumber: null
    },
    ...overrides
  };
}

describe('ConvenioMetricsService — operações em lote', () => {
  beforeEach(() => {
    globalThis.__mockPaymentFind = vi.fn();
    globalThis.__mockPaymentBulkWrite = vi.fn();
    globalThis.__mockSessionBulkWrite = vi.fn();
    globalThis.__mockBatchTransitionStatus = vi.fn();
    globalThis.__mockConvenioFind = vi.fn(createMockFind([]));

    globalThis.__mockPaymentBulkWrite.mockResolvedValue({});
    globalThis.__mockSessionBulkWrite.mockResolvedValue({});
    globalThis.__mockBatchTransitionStatus.mockResolvedValue({ success: 0, failed: 0, errors: [] });
  });

  describe('faturarEmLote', () => {
    it('usa 1 Payment.find e 1 Payment.bulkWrite para N payments', async () => {
      const p1 = buildPayment();
      const p2 = buildPayment();
      const paymentIds = [p1._id.toString(), p2._id.toString()];

      globalThis.__mockPaymentFind.mockImplementation(createMockFind([p1, p2]));

      const result = await service.faturarEmLote({
        paymentIds,
        notaFiscal: 'NF-123',
        dataFaturamento: '2026-06-15'
      });

      expect(globalThis.__mockPaymentFind).toHaveBeenCalledTimes(1);
      expect(globalThis.__mockPaymentFind).toHaveBeenCalledWith({ _id: { $in: paymentIds } });
      expect(globalThis.__mockPaymentBulkWrite).toHaveBeenCalledTimes(1);
      expect(globalThis.__mockSessionBulkWrite).toHaveBeenCalledTimes(1);
      expect(result.faturados).toBe(2);
      expect(result.totalValor).toBe(500);
      expect(result.detalhes).toHaveLength(2);
      expect(result.detalhes.every(d => d.status === 'faturado')).toBe(true);
    });

    it('ignora payments já faturados sem quebrar o lote', async () => {
      const p1 = buildPayment();
      const p2 = buildPayment({ insurance: { status: 'billed' } });
      const paymentIds = [p1._id.toString(), p2._id.toString()];

      globalThis.__mockPaymentFind.mockImplementation(createMockFind([p1, p2]));

      const result = await service.faturarEmLote({
        paymentIds,
        dataFaturamento: '2026-06-15'
      });

      expect(globalThis.__mockPaymentBulkWrite).toHaveBeenCalledTimes(1);
      // Apenas p1 deve gerar bulk op
      const ops = globalThis.__mockPaymentBulkWrite.mock.calls[0][0];
      expect(ops).toHaveLength(1);
      expect(result.faturados).toBe(1);
      expect(result.detalhes).toHaveLength(2);
      expect(result.detalhes.some(d => d.status === 'ignorado')).toBe(true);
    });
  });

  describe('receberEmLote', () => {
    it('usa 1 Payment.find, 1 Payment.bulkWrite e 1 batchTransitionStatus', async () => {
      const p1 = buildPayment({ insurance: { status: 'billed', grossAmount: 250 } });
      const p2 = buildPayment({ insurance: { status: 'billed', grossAmount: 300 } });
      const paymentIds = [p1._id.toString(), p2._id.toString()];

      globalThis.__mockPaymentFind.mockImplementation(createMockFind([p1, p2]));

      const result = await service.receberEmLote({
        paymentIds,
        dataRecebimento: '2026-06-20'
      });

      expect(globalThis.__mockPaymentFind).toHaveBeenCalledTimes(1);
      expect(globalThis.__mockPaymentFind).toHaveBeenCalledWith({ _id: { $in: paymentIds } });
      expect(globalThis.__mockPaymentBulkWrite).toHaveBeenCalledTimes(1);
      expect(globalThis.__mockBatchTransitionStatus).toHaveBeenCalledTimes(1);
      expect(globalThis.__mockBatchTransitionStatus).toHaveBeenCalledWith(
        paymentIds,
        'paid',
        expect.objectContaining({
          paymentMethod: 'convenio',
          reason: 'convenio_metrics_receipt'
        })
      );
      expect(result.recebidos).toBe(2);
      expect(result.totalValor).toBe(550);
    });

    it('conta como erro payments já recebidos (preserva contrato original)', async () => {
      const p1 = buildPayment({ insurance: { status: 'received', grossAmount: 250 } });
      const paymentIds = [p1._id.toString()];

      globalThis.__mockPaymentFind.mockImplementation(createMockFind([p1]));

      const result = await service.receberEmLote({
        paymentIds,
        dataRecebimento: '2026-06-20'
      });

      expect(globalThis.__mockPaymentBulkWrite).not.toHaveBeenCalled();
      expect(globalThis.__mockBatchTransitionStatus).not.toHaveBeenCalled();
      expect(result.recebidos).toBe(0);
      expect(result.erros).toBe(1);
    });

    it('deduz ISS automaticamente pela alíquota cadastrada no convênio (ex: Unimed 2,01%)', async () => {
      const p1 = buildPayment({
        insurance: { status: 'billed', grossAmount: 1000 },
        package: { insuranceProvider: 'unimed-anapolis', insuranceGrossAmount: 1000, sessionValue: 1000 }
      });
      const paymentIds = [p1._id.toString()];

      globalThis.__mockPaymentFind.mockImplementation(createMockFind([p1]));
      globalThis.__mockConvenioFind.mockImplementation(
        createMockFind([{ code: 'unimed-anapolis', issRate: 2.01 }])
      );

      const result = await service.receberEmLote({
        paymentIds,
        dataRecebimento: '2026-06-20'
      });

      expect(result.recebidos).toBe(1);
      expect(result.totalValor).toBe(1000);
      expect(result.totalIss).toBeCloseTo(20.1, 2);
      expect(result.totalLiquido).toBeCloseTo(979.9, 2);
      expect(result.detalhes[0].issRate).toBe(2.01);
      expect(result.detalhes[0].issAmount).toBeCloseTo(20.1, 2);
      expect(result.detalhes[0].valorLiquido).toBeCloseTo(979.9, 2);

      const ops = globalThis.__mockPaymentBulkWrite.mock.calls[0][0];
      expect(ops[0].updateOne.update.$set['insurance.receivedAmount']).toBeCloseTo(979.9, 2);
      expect(ops[0].updateOne.update.$set['insurance.issRate']).toBe(2.01);
      expect(ops[0].updateOne.update.$set['insurance.issAmount']).toBeCloseTo(20.1, 2);
      // amount (valor faturado/bruto) nunca é afetado pela retenção de ISS
      expect(ops[0].updateOne.update.$set.amount).toBe(200);
    });

    it('convênio sem issRate cadastrado (default 0) recebe o valor bruto integral', async () => {
      const p1 = buildPayment({
        insurance: { status: 'billed', grossAmount: 250 },
        package: { insuranceProvider: 'ipasgo', insuranceGrossAmount: 250, sessionValue: 250 }
      });
      const paymentIds = [p1._id.toString()];

      globalThis.__mockPaymentFind.mockImplementation(createMockFind([p1]));
      globalThis.__mockConvenioFind.mockImplementation(createMockFind([]));

      const result = await service.receberEmLote({
        paymentIds,
        dataRecebimento: '2026-06-20'
      });

      expect(result.totalIss).toBe(0);
      expect(result.totalLiquido).toBe(250);
      const ops = globalThis.__mockPaymentBulkWrite.mock.calls[0][0];
      expect(ops[0].updateOne.update.$set['insurance.receivedAmount']).toBe(250);
    });
  });
});
