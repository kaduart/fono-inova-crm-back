/**
 * Esgotamento do contrato de liminar (bug 05/11/2026):
 * ao zerar o saldo, o guard cancelava inclusive o atendimento sendo concluído
 * e os passados ainda não concluídos. Agora só cancela a partir de amanhã (SP).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindById = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockFindByIdAndUpdate = vi.fn();
vi.mock('../../models/LiminarContract.js', () => ({
  default: {
    findById: (...a) => mockFindById(...a),
    findOneAndUpdate: (...a) => mockFindOneAndUpdate(...a),
    findByIdAndUpdate: (...a) => mockFindByIdAndUpdate(...a),
  },
}));

const mockApptFind = vi.fn();
vi.mock('../../models/Appointment.js', () => ({
  default: { find: (...a) => mockApptFind(...a) },
}));

const mockCancel = vi.fn();
vi.mock('../../services/appointment/commands/cancelAppointmentCommand.js', () => ({
  executeWithSession: (...a) => mockCancel(...a),
}));

const { default: guard, buildExhaustedCancelFilter, startOfTomorrowSaoPaulo } =
  await import('../../services/financialGuard/guards/liminar.guard.js');

describe('LiminarGuard — esgotamento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockReturnValue({ session: () => ({ status: 'active', creditBalance: 150, usedCredit: 0 }) });
    mockFindOneAndUpdate.mockResolvedValue({ creditBalance: 0, usedCredit: 150 });
    mockApptFind.mockReturnValue({ session: () => ({ select: async () => [{ _id: 'futuro1' }] }) });
    mockCancel.mockResolvedValue({});
  });

  it('00:00 de amanhã em SP, inclusive perto da meia-noite', () => {
    // 05/11 23:30 SP = 06/11 02:30Z → amanhã = 06/11 00:00 SP = 06/11 03:00Z
    expect(startOfTomorrowSaoPaulo(new Date('2026-11-06T02:30:00Z')).toISOString()).toBe('2026-11-06T03:00:00.000Z');
    // 05/11 00:10 SP = 05/11 03:10Z
    expect(startOfTomorrowSaoPaulo(new Date('2026-11-05T03:10:00Z')).toISOString()).toBe('2026-11-06T03:00:00.000Z');
  });

  it('filtro exclui o atendimento atual e tudo até hoje', () => {
    const f = buildExhaustedCancelFilter({ liminarContractId: 'c1', appointmentId: 'a1', now: new Date('2026-11-05T15:00:00Z') });
    expect(f._id).toEqual({ $ne: 'a1' });
    expect(f.date.$gte.toISOString()).toBe('2026-11-06T03:00:00.000Z');
    expect(f.liminarContract).toBe('c1');
  });

  it('ao zerar, cancela só os futuros com cancelSource liminar_exhausted', async () => {
    const r = await guard.handle({
      context: 'COMPLETE_SESSION',
      payload: { liminarContractId: 'c1', sessionValue: 150, appointmentId: 'a1' },
      session: {},
    });
    expect(r.isExhausted).toBe(true);
    const filter = mockApptFind.mock.calls[0][0];
    expect(filter._id).toEqual({ $ne: 'a1' });
    expect(filter.date.$gte).toBeInstanceOf(Date);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel.mock.calls[0][0]).toBe('futuro1');
    expect(mockCancel.mock.calls[0][1]).toMatchObject({ cancelSource: 'liminar_exhausted' });
  });

  it('com saldo restante, não cancela nada', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ creditBalance: 50, usedCredit: 100 });
    await guard.handle({ context: 'COMPLETE_SESSION', payload: { liminarContractId: 'c1', sessionValue: 100, appointmentId: 'a1' }, session: {} });
    expect(mockApptFind).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});
