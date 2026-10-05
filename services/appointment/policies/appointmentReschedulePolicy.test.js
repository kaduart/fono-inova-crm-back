import { describe, it, expect } from 'vitest';
import { assertRescheduleAllowed } from './appointmentReschedulePolicy.js';

const TODAY = '2026-10-05';

const base = {
  operationalStatus: 'scheduled',
  date: new Date('2026-10-08T12:00:00.000Z'),
  time: '14:00',
  billingType: 'particular',
};

const run = (overrides = {}) =>
  assertRescheduleAllowed({
    appointment: base,
    newDate: '2026-10-12',
    newTime: '14:00',
    today: TODAY,
    ...overrides,
  });

const expectCode = (fn, code, status) => {
  try {
    fn();
  } catch (err) {
    expect(err.code).toBe(code);
    if (status) expect(err.status).toBe(status);
    return;
  }
  throw new Error(`esperava erro ${code}, mas nada foi lançado`);
};

describe('appointmentReschedulePolicy', () => {
  it('permite remarcar particular agendado para data futura', () => {
    expect(run()).toEqual({ date: '2026-10-12', time: '14:00' });
  });

  it('normaliza horário "8:00" para "08:00"', () => {
    expect(run({ newTime: '8:00' })).toEqual({ date: '2026-10-12', time: '08:00' });
  });

  it('permite remarcar para hoje', () => {
    expect(run({ newDate: TODAY }).date).toBe(TODAY);
  });

  it.each(['pre_agendado', 'confirmed', 'scheduled', 'pending'])('permite status %s', (operationalStatus) => {
    expect(() => run({ appointment: { ...base, operationalStatus } })).not.toThrow();
  });

  it.each(['canceled', 'cancelado', 'cancelada'])('permite cancelado (%s) — reaproveita o agendamento', (operationalStatus) => {
    expect(() => run({ appointment: { ...base, operationalStatus } })).not.toThrow();
  });

  it('cancelado de convênio continua respeitando a validade da guia', () => {
    const guide = { number: '1', status: 'active', expiresAt: new Date('2026-10-20T12:00:00.000Z') };
    expectCode(
      () => run({ appointment: { ...base, operationalStatus: 'canceled' }, guide, newDate: '2026-10-21' }),
      'GUIDE_EXPIRES_BEFORE_DATE',
      409
    );
  });

  it.each(['completed', 'missed', 'force_cancelled'])('bloqueia status %s (422)', (operationalStatus) => {
    expectCode(
      () => run({ appointment: { ...base, operationalStatus } }),
      'INVALID_STATUS_FOR_RESCHEDULE',
      422
    );
  });

  it('bloqueia data no passado', () => {
    expectCode(() => run({ newDate: '2026-10-04' }), 'RESCHEDULE_IN_PAST', 422);
  });

  it('bloqueia quando data e horário não mudam', () => {
    expectCode(() => run({ newDate: '2026-10-08', newTime: '14:00' }), 'NO_CHANGE', 400);
  });

  it('permite mesmo dia com outro horário', () => {
    expect(run({ newDate: '2026-10-08', newTime: '15:00' })).toEqual({ date: '2026-10-08', time: '15:00' });
  });

  it('rejeita payload inválido', () => {
    expectCode(() => run({ newDate: 'amanha' }), 'INVALID_RESCHEDULE_PAYLOAD', 400);
    expectCode(() => run({ newTime: '25:99' }), 'INVALID_RESCHEDULE_PAYLOAD', 400);
    expectCode(() => run({ newDate: '2026-02-31' }), 'INVALID_RESCHEDULE_PAYLOAD', 400);
  });

  describe('convênio', () => {
    const guide = { number: '16323329', status: 'active', expiresAt: new Date('2026-10-20T12:00:00.000Z') };

    it('permite dentro da validade da guia', () => {
      expect(() => run({ guide, newDate: '2026-10-15' })).not.toThrow();
    });

    it('permite exatamente no dia de validade', () => {
      expect(() => run({ guide, newDate: '2026-10-20' })).not.toThrow();
    });

    it('bloqueia depois da validade (409) com data na mensagem', () => {
      try {
        run({ guide, newDate: '2026-10-21' });
        throw new Error('deveria lançar');
      } catch (err) {
        expect(err.code).toBe('GUIDE_EXPIRES_BEFORE_DATE');
        expect(err.status).toBe(409);
        expect(err.message).toContain('20/10/2026');
        expect(err.message).toContain('#16323329');
      }
    });

    it.each(['expired', 'cancelled', 'superseded', 'closed'])('bloqueia guia %s', (status) => {
      expectCode(() => run({ guide: { ...guide, status } }), 'GUIDE_NOT_ACTIVE_FOR_RESCHEDULE', 409);
    });

    it('guia esgotada (exhausted) ainda permite mover sessão já provisionada', () => {
      expect(() => run({ guide: { ...guide, status: 'exhausted' } })).not.toThrow();
    });
  });

  describe('liminar', () => {
    const liminar = { expirationDate: new Date('2026-11-30T12:00:00.000Z') };

    it('permite dentro da vigência', () => {
      expect(() => run({ liminar, newDate: '2026-11-30' })).not.toThrow();
    });

    it('bloqueia depois da vigência (409)', () => {
      expectCode(() => run({ liminar, newDate: '2026-12-01' }), 'LIMINAR_EXPIRES_BEFORE_DATE', 409);
    });

    it('liminar sem data de expiração não bloqueia', () => {
      expect(() => run({ liminar: { expirationDate: null }, newDate: '2027-05-01' })).not.toThrow();
    });
  });

  it('pacote não tem validade própria — remarca normalmente', () => {
    expect(() => run({ appointment: { ...base, serviceType: 'package_session' } })).not.toThrow();
  });
});
