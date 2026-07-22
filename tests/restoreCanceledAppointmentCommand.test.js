/**
 * 🛡️ Testes unitários — restoreCanceledAppointmentCommand
 *
 * Inverso simétrico de cancelAppointmentCommand: cobre a reativação de um
 * appointment cancelado (volta pra scheduled/confirmed/pending).
 *
 * Cenário pedido explicitamente (2026-07-22): sessão que JÁ tinha sido
 * completed antes de cancelar, e depois é reativada — precisa restaurar
 * sessionsDone/financeiro, mas a Session NUNCA reabre direto pra 'completed'
 * (evita reabrir histórico financeiro silenciosamente). completedAt é
 * histórico e é preservado, nunca limpo pelo cancelamento nem pela reativação.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import { consumePackageSession, updatePackageFinancials } from '../domain/package/consumePackageSession.js';
import { executeWithSession } from '../services/appointment/commands/restoreCanceledAppointmentCommand.js';

vi.mock('../models/Session.js', () => ({
  default: { findById: vi.fn() },
}));
vi.mock('../models/Payment.js', () => ({
  default: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock('../models/Package.js', () => ({
  default: { findByIdAndUpdate: vi.fn() },
}));
vi.mock('../domain/package/consumePackageSession.js', () => ({
  consumePackageSession: vi.fn().mockResolvedValue({ consumed: true }),
  updatePackageFinancials: vi.fn().mockResolvedValue({}),
}));

const fakeMongoSession = {};

function makeSessionDoc(overrides = {}) {
  return {
    _id: 'session-1',
    status: 'canceled',
    confirmedAbsence: true,
    canceledAt: new Date('2026-07-22T10:00:00Z'),
    completedAt: null,
    isPaid: false,
    partialAmount: 0,
    paymentMethod: 'pix',
    originalPartialAmount: 0,
    originalPaymentStatus: null,
    originalIsPaid: false,
    originalPaymentMethod: null,
    history: [],
    save: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeAppointment(overrides = {}) {
  return {
    _id: 'appt-1',
    serviceType: 'package_session',
    package: { _id: 'pkg-1' },
    session: { _id: 'session-1' },
    payment: null,
    paymentOrigin: undefined,
    sessionValue: 100,
    ...overrides,
  };
}

describe('restoreCanceledAppointmentCommand.executeWithSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Package.findByIdAndUpdate.mockResolvedValue(true);
  });

  it('sessão nunca completed (só agendada e cancelada): sessionsDone não é restaurado', async () => {
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc({ completedAt: null })) });

    const result = await executeWithSession(makeAppointment(), { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(result.wasCompleted).toBe(false);
    expect(consumePackageSession).not.toHaveBeenCalled();
  });

  it('cenário pedido — sessão tinha sido completed antes de cancelar: sessionsDone restaurado, Session volta pra "scheduled" (nunca "completed")', async () => {
    const completedAt = new Date('2026-07-20T12:00:00Z');
    const sessionDoc = makeSessionDoc({ completedAt });
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(sessionDoc) });

    const result = await executeWithSession(makeAppointment(), { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(result.wasCompleted).toBe(true);
    expect(consumePackageSession).toHaveBeenCalledWith('pkg-1', { mongoSession: fakeMongoSession });
    expect(sessionDoc.status).toBe('scheduled'); // nunca 'completed' direto
    expect(sessionDoc.completedAt).toBe(completedAt); // histórico preservado, não limpo
    expect(sessionDoc.confirmedAbsence).toBe(false);
    expect(sessionDoc.canceledAt).toBeNull();
    expect(sessionDoc.save).toHaveBeenCalled();
  });

  it('per-session pago: restaura totalPaid/paidSessions do pacote e volta o Payment pra pending (nunca "paid" direto)', async () => {
    const sessionDoc = makeSessionDoc({
      completedAt: new Date(),
      originalIsPaid: true,
      originalPaymentStatus: 'paid',
      originalPartialAmount: 100,
      originalPaymentMethod: 'pix',
    });
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(sessionDoc) });
    Payment.findById.mockReturnValue({
      session: vi.fn().mockResolvedValue({ _id: 'pay-1', status: 'canceled', kind: 'appointment_payment' }),
    });

    const appt = makeAppointment({ payment: { _id: 'pay-1' }, paymentOrigin: 'auto_per_session', sessionValue: 100 });
    const result = await executeWithSession(appt, { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(result.wasPaid).toBe(true);
    expect(updatePackageFinancials).toHaveBeenCalledWith('pkg-1', 100, fakeMongoSession);
    expect(sessionDoc.isPaid).toBe(true);
    expect(sessionDoc.partialAmount).toBe(100);
    // campos 'original*' consumidos e zerados — não reaproveitam num cancel futuro
    expect(sessionDoc.originalPartialAmount).toBe(0);
    expect(sessionDoc.originalIsPaid).toBe(false);

    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'pay-1',
      expect.objectContaining({ $set: expect.objectContaining({ status: 'pending', canceledAt: null }) }),
      { session: fakeMongoSession }
    );
  });

  it('Payment kind=package_receipt: nunca é restaurado (nunca foi cancelado por essa sessão)', async () => {
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });
    Payment.findById.mockReturnValue({
      session: vi.fn().mockResolvedValue({ _id: 'pay-1', status: 'canceled', kind: 'package_receipt' }),
    });

    await executeWithSession(makeAppointment({ payment: { _id: 'pay-1' } }), { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(Payment.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('readiciona session/appointment nos arrays do Package via $addToSet (inverso do $pull do cancelamento)', async () => {
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });

    await executeWithSession(makeAppointment({ _id: 'appt-XYZ', session: { _id: 'session-XYZ' } }), { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    const addCall = Package.findByIdAndUpdate.mock.calls.find(c => c[1].$addToSet);
    expect(addCall).toBeDefined();
    expect(addCall[1].$addToSet).toEqual({ sessions: 'session-XYZ', appointments: 'appt-XYZ' });
  });

  it('sessão avulsa (sem package): não mexe em Package nem em consumePackageSession', async () => {
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });

    await executeWithSession(makeAppointment({ serviceType: 'session', package: null }), { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(consumePackageSession).not.toHaveBeenCalled();
    expect(Package.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
