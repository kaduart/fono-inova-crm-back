import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.mock('../../domain/appointment/cancelAppointments.js', () => ({ cancelAppointments: vi.fn().mockResolvedValue({ modifiedCount: 1 }) }));
vi.mock('../../domain/session/cancelPendingSessions.js', () => ({ cancelPendingSessions: vi.fn().mockResolvedValue({ modifiedCount: 1 }) }));
vi.mock('../../domain/payment/cancelPendingPayments.js', () => ({ cancelPendingPayments: vi.fn().mockResolvedValue({ modifiedCount: 1 }) }));
vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({ saveToOutbox: vi.fn().mockResolvedValue({}) }));
import { planSettledPackageClosure, applySettledPackageClosure } from '../../services/packageSettlementClosure.js';
import { calculatePackagePaymentTotals } from '../../services/packagePaymentReconciliation.js';
import { cancelAppointments } from '../../domain/appointment/cancelAppointments.js';
import { cancelPendingPayments } from '../../domain/payment/cancelPendingPayments.js';
import { saveToOutbox } from '../../infrastructure/outbox/outboxPattern.js';
import Session from '../../models/Session.js';
beforeEach(() => vi.spyOn(Session, 'find').mockReturnValue({ select: vi.fn().mockReturnThis(), session: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([{ _id: 'future-session' }]) }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
const pkg = { _id: 'package', patient: 'patient', totalValue: 640 };
const appointments = [{ _id: 'done', operationalStatus: 'completed' }, { _id: 'future', operationalStatus: 'scheduled' }];
const payments = [{ appointment: 'done', status: 'paid', amount: 160 }, { appointment: 'future', status: 'pending', amount: 160 }];
describe('settled package closure', () => {
  it('cancels remaining sessions after performed sessions are settled without inventing revenue', () => {
    const plan = planSettledPackageClosure(pkg, appointments, payments);
    expect(plan).toEqual({ appointmentIds: ['future'], billableValue: 160 });
    expect(calculatePackagePaymentTotals({ ...pkg, settlementClosure: plan }, payments))
      .toEqual({ totalPaid: 160, balance: 0, financialBalance: 0, financialStatus: 'paid' });
    expect(pkg.totalValue).toBe(640);
  });
  it.each(['pending', 'partial', 'billed'])('does not close when a performed session remains %s', status => {
    expect(planSettledPackageClosure(pkg, appointments, [{ ...payments[0], status }, payments[1]])).toBeNull();
  });
  it('does not close performed sessions with missing or canceled payment', () => {
    expect(planSettledPackageClosure(pkg, appointments, [payments[1]])).toBeNull();
    expect(planSettledPackageClosure(pkg, appointments, [{ ...payments[0], status: 'canceled' }, payments[1]])).toBeNull();
  });
  it('does not discard an advance payment for a remaining session', () => {
    expect(planSettledPackageClosure(pkg, appointments, [payments[0], { ...payments[1], status: 'paid' }])).toBeNull();
  });
  it('does not close an unused package or repeat an existing closure', () => {
    expect(planSettledPackageClosure(pkg, [appointments[1]], [payments[1]])).toBeNull();
    expect(planSettledPackageClosure({ ...pkg, settlementClosure: { closedAt: new Date() } }, appointments, payments)).toBeNull();
  });
  it('uses the same transaction and only cancels pending payments of remaining appointments', async () => {
    const session = {};
    const plan = planSettledPackageClosure(pkg, appointments, payments);
    const closure = await applySettledPackageClosure(pkg, plan, session);
    expect(cancelAppointments.mock.calls[0][0]._id.$in).toEqual(['future']);
    expect(cancelPendingPayments).toHaveBeenCalledWith({ $or: [{ appointment: { $in: ['future'] } }, { session: { $in: ['future-session'] } }], status: { $in: ['pending', 'scheduled'] } }, session);
    expect(closure).toMatchObject({ contractValue: 640, billableValue: 160, canceledAppointmentIds: ['future'] });
    expect(saveToOutbox.mock.calls.map(([event]) => event.eventType)).toEqual(['PACKAGE_UPDATED', 'APPOINTMENT_CANCELLED']);
    expect(saveToOutbox.mock.calls.every(([, value]) => value === session)).toBe(true);
  });
  it('recognizes legacy payment linked only by Session and preserves advance coverage', () => {
    const linkedAppointments = appointments.map(a => ({ ...a, session: `${a._id}-session` }));
    const linkedPayments = payments.map(p => ({ ...p, appointment: null, session: `${p.appointment}-session` }));
    expect(planSettledPackageClosure(pkg, linkedAppointments, linkedPayments)).toEqual({ appointmentIds: ['future'], billableValue: 160 });
    expect(planSettledPackageClosure(pkg, linkedAppointments, [linkedPayments[0], { ...linkedPayments[1], status: 'paid' }])).toBeNull();
  });
  it('propagates cancellation failures so the caller aborts the transaction', async () => {
    cancelAppointments.mockRejectedValueOnce(new Error('write failed'));
    await expect(applySettledPackageClosure(pkg, { appointmentIds: ['future'], billableValue: 160 }, {})).rejects.toThrow('write failed');
    expect(saveToOutbox).not.toHaveBeenCalled();
  });
});
