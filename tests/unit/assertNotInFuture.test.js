/**
 * 🧪 Guard: atendimento futuro não pode ser concluído
 *
 * Incidente 2026-08-07 (guia 16173377): appointment de 18/09 concluído em
 * 07/08 — 42 dias antes de acontecer. Consumiu autorização do convênio e
 * lançou R$ 80 de produção.
 *
 * A comparação é em horário da CLÍNICA (America/Sao_Paulo). Comparar UTC cru
 * erra os dois extremos do dia: uma sessão das 08:00 pareceria futura até as
 * 11:00, e uma das 22:00 pareceria passada. Estes testes travam isso.
 */

import { describe, it, expect } from 'vitest';
import moment from 'moment-timezone';
import {
  assertNotInFuture,
  isAppointmentInFuture,
  CLINIC_TIMEZONE,
} from '../../domain/appointment/assertNotInFuture.js';

const TZ = CLINIC_TIMEZONE;
/** Instante UTC correspondente a uma data/hora local da clínica. */
const clinic = (dateTime) => moment.tz(dateTime, 'YYYY-MM-DD HH:mm', TZ).toDate();

describe('isAppointmentInFuture', () => {
  it('reconhece o caso real: 18/09 visto de 07/08 é futuro', () => {
    const appt = { date: new Date('2026-09-18T12:00:00.000Z'), time: '15:20' };
    expect(isAppointmentInFuture(appt, clinic('2026-08-07 19:55'))).toBe(true);
  });

  it('sessão de ontem não é futura', () => {
    const appt = { date: new Date('2026-08-12T03:00:00.000Z'), time: '18:20' };
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 09:00'))).toBe(false);
  });

  it('sessão de hoje que já começou não é futura', () => {
    const appt = { date: new Date('2026-08-13T03:00:00.000Z'), time: '09:00' };
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 09:30'))).toBe(false);
  });

  it('sessão de hoje que ainda não começou É futura', () => {
    const appt = { date: new Date('2026-08-13T03:00:00.000Z'), time: '16:00' };
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 09:30'))).toBe(true);
  });
});

describe('fuso da clínica, não UTC', () => {
  // Em UTC, 08:00 BRT = 11:00Z. Comparar instantes UTC crus contra "meia-noite
  // UTC de hoje" faria a sessão das 08:00 parecer futura durante a manhã toda.
  it('sessão das 08:00, às 10:00 da manhã, é PASSADO', () => {
    const appt = { date: new Date('2026-08-13T03:00:00.000Z'), time: '08:00' };
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 10:00'))).toBe(false);
  });

  // 22:00 BRT = 01:00Z do dia seguinte. Em UTC pareceria "amanhã".
  it('sessão das 22:00 de ontem, hoje de manhã, é PASSADO', () => {
    const appt = { date: new Date('2026-08-12T03:00:00.000Z'), time: '22:00' };
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 08:00'))).toBe(false);
  });

  it('sessão das 22:00 de hoje, às 21:00, ainda é FUTURO', () => {
    const appt = { date: new Date('2026-08-13T03:00:00.000Z'), time: '22:00' };
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 21:00'))).toBe(true);
  });

  it('funciona com date gravado como 12:00Z (o formato do 18/09)', () => {
    const appt = { date: new Date('2026-08-13T12:00:00.000Z'), time: '15:20' };
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 14:00'))).toBe(true);
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 16:00'))).toBe(false);
  });

  it('sem `time`, só é passado quando o dia inteiro terminou', () => {
    const appt = { date: new Date('2026-08-13T03:00:00.000Z') };
    expect(isAppointmentInFuture(appt, clinic('2026-08-13 23:00'))).toBe(true);
    expect(isAppointmentInFuture(appt, clinic('2026-08-14 00:30'))).toBe(false);
  });
});

describe('assertNotInFuture', () => {
  const futuro = { date: new Date('2026-09-18T12:00:00.000Z'), time: '15:20' };
  const passado = { date: new Date('2026-07-17T03:00:00.000Z'), time: '15:20' };
  const agora = clinic('2026-08-13 10:00');

  it('deixa passar atendimento que já aconteceu', () => {
    expect(() => assertNotInFuture(passado, { now: agora })).not.toThrow();
  });

  it('bloqueia atendimento futuro com APPOINTMENT_IN_FUTURE e 422', () => {
    try {
      assertNotInFuture(futuro, { now: agora });
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err.code).toBe('APPOINTMENT_IN_FUTURE');
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/data futura/i);
      expect(err.message).toMatch(/18\/09\/2026/);
    }
  });

  it('a exceção administrativa libera, mas é explícita', () => {
    expect(() => assertNotInFuture(futuro, { now: agora, allowFutureCompletion: true })).not.toThrow();
  });

  it('appointment sem data não quebra o guard', () => {
    expect(() => assertNotInFuture({}, { now: agora })).not.toThrow();
  });
});
