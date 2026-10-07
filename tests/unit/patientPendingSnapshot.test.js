import { describe, it, expect } from 'vitest';
import { summarizePatientPending } from '../../services/patientPendingSnapshot.js';

describe('patient pending snapshot', () => {
  const completed = amount => ({ amount, status: 'pending', billingType: 'particular',
    kind: 'session_payment', appointment: { operationalStatus: 'completed' } });
  const credit = { type: 'credit', amount: 120, correlationId: 'receive_credit_test' };

  it('includes a newly completed session and exposes gross debt separately from credit', () => {
    const result = summarizePatientPending([completed(1090), completed(160)], [credit]);
    expect(result.payments).toHaveLength(2);
    expect(result.stats).toMatchObject({ totalPendingParticular: 1250, availableCredit: 120,
      appliedCredit: 120, totalPendingParticularNet: 1130, totalPendingNet: 1130 });
  });

  it('excludes future sessions, canceled sessions, receipts, and protected billing from patient debt', () => {
    const result = summarizePatientPending([
      completed(160),
      { ...completed(200), appointment: { operationalStatus: 'scheduled' } },
      { ...completed(200), appointment: { operationalStatus: 'canceled' } },
      { ...completed(200), kind: 'monthly_settlement' },
      { ...completed(200), billingType: 'liminar' },
      { ...completed(200), billingType: 'insurance' },
    ]);
    expect(result.payments).toHaveLength(1);
    expect(result.stats.totalPendingParticular).toBe(160);
    expect(result.stats.totalPendingConvenioAwaitingBilling).toBe(200);
  });

  it('ignores deleted credit and preserves credit left over after settling debt', () => {
    const result = summarizePatientPending([completed(80)], [credit, { ...credit, isDeleted: true }]);
    expect(result.stats).toMatchObject({ appliedCredit: 80, netAvailableCredit: 40, totalPendingNet: 0 });
  });

  it('never deducts previously used credit again, including partial use', () => {
    const used = summarizePatientPending([completed(1250)], [{ ...credit, creditUsedAmount: 120 }]);
    expect(used.stats).toMatchObject({ availableCredit: 0, appliedCredit: 0, totalPendingNet: 1250 });
    const partial = summarizePatientPending([completed(1250)], [{ ...credit, creditUsedAmount: 70 }]);
    expect(partial.stats).toMatchObject({ availableCredit: 50, appliedCredit: 50, totalPendingNet: 1200 });
  });
});
