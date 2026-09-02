/**
 * Paridade entre as invariantes extraídas e os hooks de Payment, para a
 * transição `→ paid` / `insurance.status='received'` (recebimento de NF).
 *
 * Espelha tests/unit/paymentBillingInvariants.test.js (que cobre `→ billed`).
 * O bulkWrite do recebimento não dispara pre('validate')/pre('save'), então
 * este arquivo é a rede de segurança: se alguém mexer nos hooks de Payment.js
 * sem revisitar paymentReceiptInvariants.js, é aqui que deve estourar.
 */
import { afterEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { FinancialContext } from '../../utils/financialContext.js';
import {
  assertFinancialContextAllowsPaymentWrite,
  assertPaymentReceivable,
  buildReceivedUpdate,
  PaymentReceiptInvariantError
} from '../../services/insuranceBatch/paymentReceiptInvariants.js';

const oid = () => new mongoose.Types.ObjectId();

function billedPayment(overrides = {}) {
  const patient = oid();
  const appointment = oid();
  const session = oid();
  return {
    _id: oid(),
    patient,
    patientId: patient.toString(),
    appointment,
    appointmentId: appointment.toString(),
    session,
    amount: 80,
    status: 'billed',
    billingType: 'convenio',
    kind: 'session_payment',
    isFromPackage: false,
    financialDate: null,
    paidAt: null,
    insurance: { provider: 'unimed-anapolis', status: 'billed', grossAmount: 80 },
    ...overrides
  };
}

afterEach(() => FinancialContext.clear());

describe('S2 — blindagem de contexto financeiro (reexport)', () => {
  it('bloqueia escrita quando o contexto é session', () => {
    FinancialContext.set('session');
    expect(() => assertFinancialContextAllowsPaymentWrite())
      .toThrowError(/não pode criar\/atualizar Payment/);
  });

  it('libera nos demais contextos', () => {
    FinancialContext.set('payment');
    expect(() => assertFinancialContextAllowsPaymentWrite()).not.toThrow();
  });
});

describe('assertPaymentReceivable', () => {
  it('aceita um payment de convênio faturado', () => {
    expect(() => assertPaymentReceivable(billedPayment())).not.toThrow();
  });

  it('V1 — recusa payment que não é de convênio', () => {
    expect(() => assertPaymentReceivable(billedPayment({ billingType: 'particular' })))
      .toThrowError(/não é de convênio/);
  });

  it('S7 — recusa billingType prepaid (legado removido)', () => {
    expect(() => assertPaymentReceivable(billedPayment({ billingType: 'prepaid' })))
      .toThrowError(/prepaid/);
  });

  it('V5/S3 — recusa consumo de pacote por isFromPackage', () => {
    expect(() => assertPaymentReceivable(billedPayment({ isFromPackage: true })))
      .toThrowError(/consumo de pacote/);
  });

  it('V5/S3 — recusa consumo de pacote por kind', () => {
    expect(() => assertPaymentReceivable(billedPayment({ kind: 'package_consumed' })))
      .toThrowError(/consumo de pacote/);
  });

  it('lança PaymentReceiptInvariantError com código estável', () => {
    try {
      assertPaymentReceivable(billedPayment({ billingType: 'particular' }));
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentReceiptInvariantError);
      expect(err.code).toBe('PAYMENT_BILLING_TYPE_INVALID');
    }
  });
});

describe('buildReceivedUpdate', () => {
  const now = new Date('2026-09-02T18:00:00.000Z');
  const receivedAt = new Date('2026-08-20T00:00:00.000Z');
  const ctx = { now, receivedAt, grossAmount: 80, netAmount: 78.39, issRate: 2.01 };

  it('monta a transição mínima com a flag autorizada do write guard', () => {
    const { set } = buildReceivedUpdate(billedPayment(), ctx);
    expect(set).toMatchObject({
      status: 'paid',
      paidAt: receivedAt,
      financialDate: receivedAt,
      paymentMethod: 'convenio',
      'insurance.status': 'received',
      'insurance.grossAmount': 80,
      'insurance.receivedAmount': 78.39,
      'insurance.issRate': 2.01,
      'insurance.issAmount': 1.61,
      'insurance.receivedAt': receivedAt,
      updatedAt: now,
      _fromPaymentStatusService: true
    });
  });

  it('preserva paidAt/financialDate já existentes (reprocessamento não recarimba)', () => {
    const original = new Date('2026-01-01T00:00:00.000Z');
    const payment = billedPayment({ paidAt: original, financialDate: original });
    const { set } = buildReceivedUpdate(payment, ctx);
    expect(set).not.toHaveProperty('paidAt');
    expect(set).not.toHaveProperty('financialDate');
  });

  it('S4 — falha alto se paidAt resultante ficaria ausente', () => {
    const payment = billedPayment({ paidAt: null });
    expect(() => buildReceivedUpdate(payment, { ...ctx, receivedAt: null }))
      .toThrowError(/paidAt é obrigatório/);
  });

  it('V2/V3 — reconstrói patientId e appointmentId ausentes', () => {
    const payment = billedPayment({ patientId: undefined, appointmentId: undefined });
    const { set, warnings } = buildReceivedUpdate(payment, ctx);
    expect(set.patientId).toBe(payment.patient.toString());
    expect(set.appointmentId).toBe(payment.appointment.toString());
    expect(warnings.join()).toMatch(/patientId/);
    expect(warnings.join()).toMatch(/appointmentId/);
  });

  it('V7 — infere kind ausente em documento legado', () => {
    const payment = billedPayment({ kind: null });
    const { set, warnings } = buildReceivedUpdate(payment, ctx);
    expect(set.kind).toBeTruthy();
    expect(set.kind).not.toBe('unknown_or_orphan');
    expect(set.kindSource).toBe('inferred_on_receipt');
    expect(warnings.join()).toMatch(/kind ausente inferido/);
  });

  it('V7 — falha alto quando nem a inferência resolve o kind', () => {
    const payment = billedPayment({
      kind: null, patient: null, patientId: null, session: null, appointment: null, appointmentId: null
    });
    expect(() => buildReceivedUpdate(payment, ctx)).toThrowError(/PAYMENT_KIND_ENFORCEMENT/);
  });

  describe('materialização dos defaults financeiros — nunca sobrescreve valor de negócio', () => {
    it('grava netAmount=0 e splitMethods=[] quando ausentes, SEM tocar em receivedAmount/issRate/issAmount de negócio', () => {
      const payment = billedPayment({
        insurance: { provider: 'unimed-anapolis', status: 'billed', grossAmount: 80 }
      });
      delete payment.splitMethods;

      const { set } = buildReceivedUpdate(payment, ctx);

      expect(set['insurance.netAmount']).toBe(0);
      expect(set.splitMethods).toEqual([]);
      // Regressão do bug pego antes de escrever este teste: a materialização
      // sobrescrevia estes três de volta pro default 0, zerando o valor real
      // do recebimento sempre que o Payment ainda não os tinha setado.
      expect(set['insurance.receivedAmount']).toBe(78.39);
      expect(set['insurance.issRate']).toBe(2.01);
      expect(set['insurance.issAmount']).toBe(1.61);
    });

    it('preserva netAmount/splitMethods já existentes', () => {
      const payment = billedPayment({
        insurance: { provider: 'unimed-anapolis', status: 'billed', grossAmount: 80, netAmount: 72.4 },
        splitMethods: [{ method: 'pix', amount: 80 }]
      });

      const { set } = buildReceivedUpdate(payment, ctx);

      expect(set).not.toHaveProperty('insurance.netAmount');
      expect(set).not.toHaveProperty('splitMethods');
    });

    it('materializa mesmo quando o subdocumento insurance não existe', () => {
      const payment = billedPayment({ insurance: undefined });
      delete payment.splitMethods;

      const { set } = buildReceivedUpdate(payment, ctx);

      expect(set['insurance.netAmount']).toBe(0);
      expect(set.splitMethods).toEqual([]);
      expect(set['insurance.receivedAmount']).toBe(78.39);
    });
  });

  it('NÃO cria receivedAtSource de topo nem outro campo fora do schema', () => {
    const { set } = buildReceivedUpdate(billedPayment(), ctx);
    expect(set).not.toHaveProperty('billedAt');
    expect(set).not.toHaveProperty('receivedAtSource');
  });
});
