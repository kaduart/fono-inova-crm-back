import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import BillingSubmission from '../../models/BillingSubmission.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import InsuranceCommunication from '../../models/InsuranceCommunication.js';
import { BillingSubmissionError, __testables } from '../../services/billingSubmission/BillingSubmissionService.js';

const oid = () => new mongoose.Types.ObjectId();

describe('BillingSubmission V1 — contrato de domínio', () => {
  it('aceita invoice nula ou parcial enquanto draft', () => {
    const sessionId = oid();
    const submission = new BillingSubmission({
      patientId: oid(),
      insuranceProviderId: oid(),
      billingCompetence: '2026-08',
      sessionIds: [sessionId],
      billingAllocations: [{
        sessionIds: [sessionId],
        invoice: { invoiceNumber: '5001', invoiceDate: null, documentId: null }
      }],
      createdBy: oid()
    });

    expect(submission.validateSync()).toBeUndefined();
  });

  it('exige cobertura exata e disjunta das sessões', () => {
    const first = oid();
    const second = oid();
    expect(() => __testables.assertAllocationCoverage(
      [first, second],
      [{ sessionIds: [first], invoice: null }, { sessionIds: [second], invoice: null }]
    )).not.toThrow();

    expect(() => __testables.assertAllocationCoverage(
      [first, second],
      [{ sessionIds: [first], invoice: null }]
    )).toThrowError(expect.objectContaining({ code: 'BILLING_SUBMISSION_INCOMPLETE_COVERAGE' }));

    expect(() => __testables.assertAllocationCoverage(
      [first, second],
      [{ sessionIds: [first], invoice: null }, { sessionIds: [first, second], invoice: null }]
    )).toThrowError(expect.objectContaining({ code: 'BILLING_SUBMISSION_DUPLICATE_SESSION' }));
  });

  it('bloqueia finalize quando qualquer alocação não possui NF completa', () => {
    const sessionId = oid();
    try {
      __testables.assertAllocationCoverage(
        [sessionId],
        [{ sessionIds: [sessionId], invoice: null }],
        { requireInvoices: true }
      );
      throw new Error('esperava falha');
    } catch (error) {
      expect(error).toBeInstanceOf(BillingSubmissionError);
      expect(error.code).toBe('BILLING_SUBMISSION_INVOICE_REQUIRED');
    }
  });

  it('declara a reserva única parcial para sessions de submissions draft', () => {
    const index = BillingSubmission.schema.indexes().find(([, options]) =>
      options.name === 'unique_draft_billing_submission_per_session'
    );
    expect(index).toBeTruthy();
    expect(index[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { status: 'draft' }
    });
  });

  it('mantém os vínculos novos opcionais nos modelos compartilhados com o legado', () => {
    expect(InsuranceBatch.schema.path('billingSubmissionId')).toBeTruthy();
    expect(InsuranceBatch.schema.path('billingAllocationId')).toBeTruthy();
    expect(InsuranceBatch.schema.path('invoiceDocumentId')).toBeTruthy();
    expect(InsuranceCommunication.schema.path('billingSubmissionId')).toBeTruthy();
    expect(InsuranceCommunication.schema.path('sentAt')).toBeTruthy();
  });
});
