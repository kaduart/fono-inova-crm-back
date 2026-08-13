/**
 * Paridade entre as invariantes extraídas e os hooks de Payment.
 *
 * O bulkWrite do faturamento não dispara pre('validate')/pre('save'), então este
 * arquivo é a rede de segurança: se alguém mexer nos hooks de Payment.js sem
 * revisitar paymentBillingInvariants.js, é aqui que deve estourar.
 */
import { afterEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { FinancialContext } from '../../utils/financialContext.js';
import {
  assertFinancialContextAllowsPaymentWrite,
  assertPaymentBillable,
  buildBilledUpdate
} from '../../services/billingSubmission/paymentBillingInvariants.js';

const oid = () => new mongoose.Types.ObjectId();

function billablePayment(overrides = {}) {
  const patient = oid();
  const appointment = oid();
  return {
    _id: oid(),
    patient,
    patientId: patient.toString(),
    appointment,
    appointmentId: appointment.toString(),
    session: oid(),
    amount: 80,
    status: 'pending',
    billingType: 'convenio',
    kind: 'session_payment',
    isFromPackage: false,
    financialDate: null,
    paidAt: null,
    insurance: { provider: 'unimed-anapolis', status: 'pending_billing', grossAmount: 80 },
    ...overrides
  };
}

afterEach(() => FinancialContext.clear());

describe('S2 — blindagem de contexto financeiro', () => {
  it('bloqueia escrita quando o contexto é session', () => {
    FinancialContext.set('session');
    expect(() => assertFinancialContextAllowsPaymentWrite())
      .toThrowError(/não pode criar\/atualizar Payment/);
  });

  it('bloqueia escrita quando o contexto é appointment', () => {
    FinancialContext.set('appointment');
    expect(() => assertFinancialContextAllowsPaymentWrite())
      .toThrowError(/não pode criar\/atualizar Payment/);
  });

  it('libera nos demais contextos', () => {
    FinancialContext.set('payment');
    expect(() => assertFinancialContextAllowsPaymentWrite()).not.toThrow();
    FinancialContext.clear();
    expect(() => assertFinancialContextAllowsPaymentWrite()).not.toThrow();
  });
});

describe('asserções de elegibilidade', () => {
  it('aceita um payment de convênio pendente', () => {
    expect(() => assertPaymentBillable(billablePayment())).not.toThrow();
    expect(() => assertPaymentBillable(billablePayment({ status: 'pending_billing' }))).not.toThrow();
  });

  it('V1 — recusa payment que não é de convênio', () => {
    expect(() => assertPaymentBillable(billablePayment({ billingType: 'particular' })))
      .toThrowError(/não é de convênio/);
  });

  it('V5/S3 — recusa consumo de pacote por isFromPackage', () => {
    expect(() => assertPaymentBillable(billablePayment({ isFromPackage: true })))
      .toThrowError(/consumo de pacote/);
  });

  it('V5/S3 — recusa consumo de pacote por kind', () => {
    expect(() => assertPaymentBillable(billablePayment({ kind: 'package_consumed' })))
      .toThrowError(/consumo de pacote/);
  });

  it('recusa status que não pode virar billed', () => {
    expect(() => assertPaymentBillable(billablePayment({ status: 'paid' })))
      .toThrowError(/não pode transicionar para 'billed'/);
    expect(() => assertPaymentBillable(billablePayment({ status: 'billed' })))
      .toThrowError(/não pode transicionar para 'billed'/);
  });
});

describe('buildBilledUpdate', () => {
  const now = new Date('2026-08-13T16:47:00.000Z');

  it('monta a transição mínima com a flag autorizada do write guard', () => {
    const { set } = buildBilledUpdate(billablePayment(), { now });
    expect(set).toMatchObject({
      status: 'billed',
      'insurance.status': 'billed',
      'insurance.billedAt': now,
      'insurance.billedAtSource': 'paymentStatusService',
      _fromInsuranceOrchestrator: true,
      updatedAt: now
    });
  });

  it('NÃO cria billedAt de topo — o campo não existe no schema e o strict mode do Mongoose o descartava', () => {
    const { set } = buildBilledUpdate(billablePayment(), { now });
    expect(set).not.toHaveProperty('billedAt');
  });

  it('preserva billedAt já existente (reprocessamento não recarimba)', () => {
    const original = new Date('2026-01-01T00:00:00.000Z');
    const payment = billablePayment({
      insurance: { provider: 'unimed-anapolis', status: 'pending_billing', grossAmount: 80, billedAt: original }
    });
    const { set } = buildBilledUpdate(payment, { now });
    expect(set).not.toHaveProperty('insurance.billedAt');
    expect(set).not.toHaveProperty('insurance.billedAtSource');
  });

  it('V2/V3 — reconstrói patientId e appointmentId ausentes', () => {
    const payment = billablePayment({ patientId: undefined, appointmentId: undefined });
    const { set, warnings } = buildBilledUpdate(payment, { now });
    expect(set.patientId).toBe(payment.patient.toString());
    expect(set.appointmentId).toBe(payment.appointment.toString());
    expect(warnings).toHaveLength(2);
  });

  it('V2/V3 — não mexe em patientId/appointmentId já preenchidos', () => {
    const { set, warnings } = buildBilledUpdate(billablePayment(), { now });
    expect(set).not.toHaveProperty('patientId');
    expect(set).not.toHaveProperty('appointmentId');
    expect(warnings).toHaveLength(0);
  });

  it('V7 — infere kind ausente em documento legado', () => {
    const payment = billablePayment({ kind: null });
    const { set, warnings } = buildBilledUpdate(payment, { now });
    expect(set.kind).toBeTruthy();
    expect(set.kind).not.toBe('unknown_or_orphan');
    expect(set.kindSource).toBe('inferred_on_billing');
    expect(warnings.join()).toMatch(/kind ausente inferido/);
  });

  // resolvePaymentKind só devolve unknown_or_orphan/low quando o payment não tem
  // patient — é o único caso em que o hook original também lançava.
  // Paridade com o .save(): o Mongoose aplicava o default do schema ao hidratar
  // um documento com o caminho ausente e o save persistia esse valor. O
  // bulkWrite não hidrata, então a materialização é explícita.
  describe('materialização dos defaults financeiros', () => {
    it('grava os defaults quando os campos estão ausentes', () => {
      const payment = billablePayment({
        insurance: { provider: 'unimed-anapolis', status: 'pending_billing', grossAmount: 80 }
      });
      delete payment.splitMethods;

      const { set } = buildBilledUpdate(payment, { now });

      expect(set['insurance.netAmount']).toBe(0);
      expect(set['insurance.receivedAmount']).toBe(0);
      expect(set['insurance.issRate']).toBe(0);
      expect(set['insurance.issAmount']).toBe(0);
      expect(set.splitMethods).toEqual([]);
    });

    it('preserva valores já existentes, inclusive zeros e arrays preenchidos', () => {
      const payment = billablePayment({
        insurance: {
          provider: 'unimed-anapolis',
          status: 'pending_billing',
          grossAmount: 80,
          netAmount: 72.4,
          receivedAmount: 0,
          issRate: 5,
          issAmount: 4
        },
        splitMethods: [{ method: 'pix', amount: 80 }]
      });

      const { set } = buildBilledUpdate(payment, { now });

      expect(set).not.toHaveProperty('insurance.netAmount');
      expect(set).not.toHaveProperty('insurance.receivedAmount');
      expect(set).not.toHaveProperty('insurance.issRate');
      expect(set).not.toHaveProperty('insurance.issAmount');
      expect(set).not.toHaveProperty('splitMethods');
    });

    it('trata null como valor gravado, não como ausência', () => {
      const payment = billablePayment({
        insurance: {
          provider: 'unimed-anapolis',
          status: 'pending_billing',
          grossAmount: 80,
          netAmount: null
        }
      });

      const { set } = buildBilledUpdate(payment, { now });

      expect(set).not.toHaveProperty('insurance.netAmount');
      // os demais continuam ausentes e recebem o default
      expect(set['insurance.issRate']).toBe(0);
    });

    it('materializa os defaults mesmo quando o subdocumento insurance não existe', () => {
      const payment = billablePayment({ insurance: undefined });
      delete payment.splitMethods;

      const { set } = buildBilledUpdate(payment, { now });

      expect(set['insurance.netAmount']).toBe(0);
      expect(set['insurance.issAmount']).toBe(0);
      expect(set.splitMethods).toEqual([]);
    });

    it('não compartilha a mesma referência de array entre payments', () => {
      const first = billablePayment();
      const second = billablePayment();
      delete first.splitMethods;
      delete second.splitMethods;

      const a = buildBilledUpdate(first, { now }).set;
      const b = buildBilledUpdate(second, { now }).set;

      expect(a.splitMethods).not.toBe(b.splitMethods);
    });
  });

  it('V7 — falha alto quando nem a inferência resolve o kind', () => {
    const payment = billablePayment({
      kind: null,
      patient: null,
      patientId: null,
      session: null,
      appointment: null,
      appointmentId: null,
      package: null
    });
    expect(() => buildBilledUpdate(payment, { now })).toThrowError(/PAYMENT_KIND_ENFORCEMENT/);
  });
});
