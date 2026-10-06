import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sessionUpdateOne, appointmentUpdateOne, paymentUpdateMany } = vi.hoisted(() => ({
  sessionUpdateOne: vi.fn().mockResolvedValue({}),
  appointmentUpdateOne: vi.fn().mockResolvedValue({}),
  paymentUpdateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
}));

vi.mock('../../models/Session.js', () => ({ default: { updateOne: sessionUpdateOne } }));
vi.mock('../../models/Appointment.js', () => ({ default: { updateOne: appointmentUpdateOne } }));
vi.mock('../../models/Payment.js', () => ({ default: { updateMany: paymentUpdateMany } }));

import { applyGuideValueToLinkedSession } from './applyGuideValueToLinkedSession.js';

const mongoSession = { id: 'tx' };
const session = { _id: 's1', appointmentId: 'a1' };

describe('applyGuideValueToLinkedSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('espelha o valor da guia na sessão, no agendamento e no pagamento pendente', async () => {
    const r = await applyGuideValueToLinkedSession({ session, guide: { insurance: 'base', sessionValue: 105 }, mongoSession });

    expect(r).toEqual({ applied: true, value: 105, paymentsUpdated: 1 });
    expect(sessionUpdateOne).toHaveBeenCalledWith({ _id: 's1' }, { $set: { sessionValue: 105 } }, { session: mongoSession });
    expect(appointmentUpdateOne).toHaveBeenCalledWith(
      { _id: 'a1' },
      { $set: { insuranceValue: 105, sessionValue: 105 } },
      { session: mongoSession }
    );
  });

  it('só reescreve Payment pendente e não faturado — nunca faturado/recebido (invariante #23)', async () => {
    await applyGuideValueToLinkedSession({ session, guide: { insurance: 'base', sessionValue: 105 }, mongoSession });

    const [filter, update] = paymentUpdateMany.mock.calls[0];
    expect(filter).toMatchObject({
      session: 's1',
      billingType: 'convenio',
      status: 'pending',
      'insurance.status': { $in: ['pending', 'pending_billing', null] },
    });
    expect(update).toEqual({ $set: { amount: 105, 'insurance.grossAmount': 105 } });
    // nunca troca o status do pagamento
    expect(JSON.stringify(update)).not.toContain('"status"');
  });

  it('convênio que não é Base não é alterado', async () => {
    const r = await applyGuideValueToLinkedSession({ session, guide: { insurance: 'unimed-anapolis', sessionValue: 105 }, mongoSession });
    expect(r).toEqual({ applied: false, reason: 'NOT_BASE_CONVENIO' });
    expect(sessionUpdateOne).not.toHaveBeenCalled();
  });

  it('guia sem valor não altera nada', async () => {
    const r = await applyGuideValueToLinkedSession({ session, guide: { insurance: 'base', sessionValue: 0 }, mongoSession });
    expect(r).toEqual({ applied: false, reason: 'GUIDE_WITHOUT_VALUE' });
    expect(sessionUpdateOne).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it('sessão sem agendamento não tenta atualizar Appointment', async () => {
    await applyGuideValueToLinkedSession({ session: { _id: 's2' }, guide: { insurance: 'base', sessionValue: 70 }, mongoSession });
    expect(appointmentUpdateOne).not.toHaveBeenCalled();
    expect(sessionUpdateOne).toHaveBeenCalled();
  });
});
