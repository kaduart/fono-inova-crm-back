import { describe, expect, it, vi } from 'vitest';
import {
  addDaysYMD,
  displayText,
  generateBookingCode,
  isDateInWindow,
  isHoneypotFilled,
  isValidBookingCode,
  normalizeBRPhone,
  periodOf,
  periodsAvailability,
  pickSlotForPeriod,
  publicStatusOf,
  todaySP,
  validateHoldPayload,
} from '../../services/publicBooking/publicBookingRules.js';
import { verifyTurnstile } from '../../routes/publicBooking.js';

// Terça, 10/11/2026 18h em São Paulo
const NOW = new Date('2026-11-10T21:00:00Z');

describe('agendamento público — regras', () => {
  it('período: antes de 12:00 é manhã', () => {
    expect(periodOf('08:00')).toBe('manha');
    expect(periodOf('11:20')).toBe('manha');
    expect(periodOf('12:00')).toBe('tarde');
    expect(periodOf('17:40')).toBe('tarde');
    expect(periodOf('x')).toBeNull();
  });

  it('janela: de amanhã até 14 dias, nunca hoje', () => {
    expect(todaySP(NOW)).toBe('2026-11-10');
    expect(isDateInWindow('2026-11-10', NOW)).toBe(false);
    expect(isDateInWindow('2026-11-11', NOW)).toBe(true);
    expect(isDateInWindow(addDaysYMD('2026-11-10', 14), NOW)).toBe(true);
    expect(isDateInWindow(addDaysYMD('2026-11-10', 15), NOW)).toBe(false);
    expect(isDateInWindow('lixo', NOW)).toBe(false);
  });

  it('texto genérico do horário (sem hora exata)', () => {
    expect(displayText('2026-11-12', 'manha')).toBe('Quinta 12/11 de manhã');
    expect(displayText('2026-11-13', 'tarde')).toBe('Sexta 13/11 à tarde');
  });

  it('ignora slot ocupado e slot "sombra" de paciente recorrente', () => {
    const candidates = [
      { doctorId: 'a', slots: [{ time: '08:00', available: false }, { time: '09:00', available: true, signals: { isShadow: true } }] },
      { doctorId: 'b', slots: [{ time: '14:00', available: true }] },
    ];
    expect(periodsAvailability(candidates)).toEqual([
      { period: 'manha', available: false },
      { period: 'tarde', available: true },
    ]);
    expect(pickSlotForPeriod(candidates, 'manha')).toBeNull();
  });

  it('escolhe o profissional menos ocupado e o primeiro horário do período', () => {
    const candidates = [
      { doctorId: 'cheio', slots: [{ time: '08:00', available: true }, { time: '09:00', available: false }] },
      { doctorId: 'livre', slots: [{ time: '10:00', available: true }, { time: '08:40', available: true }, { time: '14:00', available: true }] },
    ];
    const pick = pickSlotForPeriod(candidates, 'manha');
    expect(pick.doctorId).toBe('livre');
    expect(pick.time).toBe('08:40');
  });

  it('telefone BR com DDD', () => {
    expect(normalizeBRPhone('(62) 99999-0000')).toBe('62999990000');
    expect(normalizeBRPhone('+55 62 99999-0000')).toBe('62999990000');
    expect(normalizeBRPhone('99999-0000')).toBeNull();
  });

  it('valida o pedido e devolve mensagens por campo', () => {
    const ok = validateHoldPayload({
      specialty: 'fonoaudiologia',
      date: '2026-11-12',
      period: 'manha',
      child: { fullName: 'Maria  Clara Souza', birthDate: '2021-05-10' },
      responsible: { name: 'Ana Souza', phone: '62 99999-0000' },
      consentLgpd: true,
      utm: { source: 'instagram', medium: 'bio', extra: 'x' },
    }, { now: NOW, env: {} });
    expect(ok.ok).toBe(true);
    expect(ok.data.childName).toBe('Maria Clara Souza');
    expect(ok.data.phone).toBe('62999990000');
    expect(ok.data.utm).toEqual({ source: 'instagram', medium: 'bio' });

    const bad = validateHoldPayload({ specialty: 'cardiologia', date: '2026-11-10', period: 'noite', child: { fullName: '<b>' } }, { now: NOW, env: {} });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(['birthDate', 'childName', 'consentLgpd', 'date', 'period', 'phone', 'responsibleName', 'specialty']);
  });

  it('especialidades vêm do ambiente quando configuradas', () => {
    const r = validateHoldPayload({ specialty: 'fonoaudiologia' }, { now: NOW, env: { PUBLIC_BOOKING_SPECIALTIES: 'psicologia' } });
    expect(r.errors.specialty).toBeTruthy();
  });

  it('isca, código e status público', () => {
    expect(isHoneypotFilled({ website: 'http://spam' })).toBe(true);
    expect(isHoneypotFilled({ website: '' })).toBe(false);
    const code = generateBookingCode();
    expect(isValidBookingCode(code)).toBe(true);
    expect(isValidBookingCode('FI-ABC')).toBe(false);
    expect(publicStatusOf('pre_agendado')).toBe('reservado');
    expect(publicStatusOf('scheduled')).toBe('confirmado');
    expect(publicStatusOf('canceled')).toBe('encerrado');
  });
});

describe('agendamento público — captcha', () => {
  it('sem chave configurada não bloqueia', async () => {
    expect(await verifyTurnstile(undefined, '1.1.1.1', { env: {} })).toBe(true);
  });

  it('com chave exige token válido', async () => {
    const env = { TURNSTILE_SECRET_KEY: 'k' };
    expect(await verifyTurnstile('', '1.1.1.1', { env })).toBe(false);
    const ok = vi.fn(async () => ({ json: async () => ({ success: true }) }));
    expect(await verifyTurnstile('t', '1.1.1.1', { env, fetchImpl: ok })).toBe(true);
    const no = vi.fn(async () => ({ json: async () => ({ success: false }) }));
    expect(await verifyTurnstile('t', '1.1.1.1', { env, fetchImpl: no })).toBe(false);
  });
});

describe('agendamento público — rota', async () => {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createPublicBookingRouter } = await import('../../routes/publicBooking.js');

  const appWith = (env) => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/booking', createPublicBookingRouter({ env }));
    return app;
  };

  it('desligada por padrão (503)', async () => {
    const r = await request(appWith({})).get('/api/public/booking/options?specialty=fonoaudiologia');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('DISABLED');
  });

  it('valida especialidade e campos sem tocar no banco', async () => {
    const app = appWith({ PUBLIC_BOOKING_ENABLED: 'true' });
    const a = await request(app).get('/api/public/booking/options?specialty=cardiologia');
    expect(a.status).toBe(400);
    const b = await request(app).post('/api/public/booking/hold').send({ specialty: 'fonoaudiologia' });
    expect(b.status).toBe(400);
    expect(b.body.fields.phone).toBeTruthy();
    const c = await request(app).get('/api/public/booking/xyz');
    expect(c.status).toBe(404);
  });

  it('isca preenchida responde 201 e não grava', async () => {
    const r = await request(appWith({ PUBLIC_BOOKING_ENABLED: 'true' })).post('/api/public/booking/hold').send({ website: 'spam' });
    expect(r.status).toBe(201);
    expect(r.body.code).toBe('FI-000000');
  });
});
