import { describe, it, expect, vi, afterEach } from 'vitest';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import Payment from '../../models/Payment.js';
import { calculatePackagePaymentTotals, reconcilePackagesForPayments } from '../../services/packagePaymentReconciliation.js';

afterEach(() => vi.restoreAllMocks());
const query = value => ({ select: vi.fn().mockReturnThis(), session: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(value) });

describe('package payment reconciliation', () => {
  it('uses money from Payments instead of multiplying paid sessions; excludes aggregate receipts', () => {
    expect(calculatePackagePaymentTotals({ totalValue: 640, sessionValue: 160 }, [
      { status: 'paid', kind: 'session_payment', amount: 600 },
      { status: 'paid', kind: 'monthly_settlement', amount: 600 },
      { status: 'pending', kind: 'session_payment', amount: 160 },
    ])).toEqual({ totalPaid: 600, financialBalance: 40, balance: 40, financialStatus: 'partially_paid' });
  });

  it('updates a legacy package linked only through Appointment and is idempotent', async () => {
    const packageId = '6a7f5b001356b5ac803b1431';
    const appointment = '6a7f5b001356b5ac803b1434';
    vi.spyOn(Appointment, 'find').mockReturnValue(query([{ _id: appointment, package: packageId }]));
    vi.spyOn(Package, 'find').mockReturnValue(query([{ _id: packageId, totalValue: 640, sessionValue: 160 }]));
    vi.spyOn(Payment, 'find').mockReturnValue(query(Array.from({ length: 4 }, () => ({ status: 'paid', kind: 'session_payment', amount: 160 }))));
    const write = vi.spyOn(Package, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    const payment = { package: null, appointment };
    expect(await reconcilePackagesForPayments([payment])).toEqual([packageId]);
    await reconcilePackagesForPayments([payment]);
    const expected = { $set: { totalPaid: 640, balance: 0, financialBalance: 0, financialStatus: 'paid' } };
    expect(write.mock.calls[0][1]).toEqual(expected);
    expect(write.mock.calls[1][1]).toEqual(expected);
  });

  it('preserves coverage transferred from another package', () => {
    expect(calculatePackagePaymentTotals({ totalValue: 640, fundedByTransfer: 480 }, [
      { status: 'paid', kind: 'session_payment', amount: 160 },
    ])).toEqual({ totalPaid: 640, balance: 0, financialBalance: 0, financialStatus: 'paid' });
  });

  it('preserves a surplus as negative financial balance, as defined by Package', () => {
    expect(calculatePackagePaymentTotals({ totalValue: 640 }, [
      { status: 'paid', kind: 'session_payment', amount: 700 },
    ])).toEqual({ totalPaid: 700, balance: -60, financialBalance: -60, financialStatus: 'paid' });
  });

  it('limits reconciliation to per-session particular packages', async () => {
    const find = vi.spyOn(Package, 'find').mockReturnValue(query([]));
    expect(await reconcilePackagesForPayments([{ package: '6a7f5b001356b5ac803b1431' }])).toEqual([]);
    expect(find.mock.calls[0][0]).toMatchObject({
      $or: [{ model: 'per_session' }, { paymentType: 'per-session' }],
      type: { $nin: ['convenio', 'liminar'] },
    });
  });
});
