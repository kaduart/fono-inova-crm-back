/**
 * 🛡️ Testes unitários — restorePackageOnCancel
 *
 * Cobre os guards que faltavam no cancelAppointmentCommand.js (2026-07-22):
 * - só decrementa sessionsDone quando o appointment cancelado JÁ estava completed
 * - nunca deixa sessionsDone < 0
 * - só estorna totalPaid/paidSessions quando paymentOrigin === 'auto_per_session'
 * - pacote pré-pago (paymentOrigin !== 'auto_per_session') nunca tem Payment/agregados mexidos aqui
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Package from '../models/Package.js';
import { restorePackageOnCancel } from '../domain/package/restorePackageOnCancel.js';

vi.mock('../models/Package.js', () => ({
  default: {
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

function makePackage(overrides = {}) {
  return {
    _id: 'pkg-1',
    sessionsDone: 0,
    totalSessions: 4,
    totalPaid: 0,
    totalValue: 400,
    balance: 400,
    financialStatus: 'unpaid',
    ...overrides,
  };
}

describe('restorePackageOnCancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cenário 1 — pacote pré-pago + sessão agendada (nunca completed): sessionsDone não muda', async () => {
    Package.findById.mockResolvedValue(makePackage({ sessionsDone: 0 }));

    const result = await restorePackageOnCancel('pkg-1', {
      appointmentStatus: 'scheduled',
      paymentOrigin: undefined,
      sessionValue: 100,
    });

    expect(result.restored).toBe(false);
    expect(result.reason).toBe('APPOINTMENT_NOT_COMPLETED');
    expect(Package.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cenário 2 — pacote pré-pago + sessão concluída: decrementa sessionsDone, não mexe em totalPaid', async () => {
    Package.findById.mockResolvedValue(makePackage({ sessionsDone: 2, totalPaid: 400, totalValue: 400 }));
    Package.findOneAndUpdate.mockResolvedValue(makePackage({ sessionsDone: 1, totalPaid: 400, totalValue: 400 }));
    Package.findByIdAndUpdate.mockResolvedValue(makePackage({ sessionsDone: 1, totalPaid: 400, totalValue: 400, balance: 0, financialStatus: 'paid' }));

    const result = await restorePackageOnCancel('pkg-1', {
      appointmentStatus: 'completed',
      paymentOrigin: 'package_prepaid',
      sessionValue: 100,
    });

    expect(result.restored).toBe(true);
    const updateArg = Package.findOneAndUpdate.mock.calls[0][1];
    expect(updateArg.$inc).toEqual({ sessionsDone: -1 });
    expect(updateArg.$inc.totalPaid).toBeUndefined();
    expect(updateArg.$inc.paidSessions).toBeUndefined();
  });

  it('cenário 3 — pacote por sessão + pagamento realizado: estorna sessionsDone, totalPaid e paidSessions juntos', async () => {
    Package.findById.mockResolvedValue(makePackage({ sessionsDone: 3, totalPaid: 300, totalValue: 400 }));
    Package.findOneAndUpdate.mockResolvedValue(makePackage({ sessionsDone: 2, totalPaid: 200, totalValue: 400 }));
    Package.findByIdAndUpdate.mockResolvedValue(makePackage({ sessionsDone: 2, totalPaid: 200, totalValue: 400, balance: 200, financialStatus: 'partially_paid' }));

    const result = await restorePackageOnCancel('pkg-1', {
      appointmentStatus: 'completed',
      paymentOrigin: 'auto_per_session',
      sessionValue: 100,
    });

    expect(result.restored).toBe(true);
    const updateArg = Package.findOneAndUpdate.mock.calls[0][1];
    expect(updateArg.$inc).toEqual({ sessionsDone: -1, totalPaid: -100, paidSessions: -1 });
  });

  it('cenário 4 — sessão avulsa (sem package_session): não é chamada — comportamento fora do escopo desta função', async () => {
    // documental: cancelAppointmentCommand só chama restorePackageOnCancel quando
    // serviceType === 'package_session'; para avulso ela simplesmente não roda.
    expect(Package.findById).not.toHaveBeenCalled();
  });

  it('cenário 5 — cancelamento repetido: nunca gera sessionsDone < 0 (guard $gt:0 barra o update)', async () => {
    Package.findById.mockResolvedValue(makePackage({ sessionsDone: 0 }));
    Package.findOneAndUpdate.mockResolvedValue(null); // guard sessionsDone:{$gt:0} não bate → retorna null

    const result = await restorePackageOnCancel('pkg-1', {
      appointmentStatus: 'completed',
      paymentOrigin: 'package_prepaid',
      sessionValue: 100,
    });

    expect(result.restored).toBe(false);
    expect(result.reason).toBe('NO_SESSIONS_TO_RESTORE');
    // confirma que a query de update sempre inclui o guard sessionsDone > 0
    const filterArg = Package.findOneAndUpdate.mock.calls[0][0];
    expect(filterArg.sessionsDone).toEqual({ $gt: 0 });
  });

  it('idempotência: alreadyCanceled=true não toca no Package', async () => {
    const result = await restorePackageOnCancel('pkg-1', {
      appointmentStatus: 'completed',
      alreadyCanceled: true,
    });

    expect(result.restored).toBe(false);
    expect(result.reason).toBe('ALREADY_CANCELED');
    expect(Package.findById).not.toHaveBeenCalled();
  });
});
