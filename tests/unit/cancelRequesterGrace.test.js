import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseCancelRequester, LEGACY_GRACE_ENDS_AT_ISO } from '../../domain/appointment/cancelRequester.js';

// Prazo de compatibilidade (telas antigas do CRM sem solicitante): instante exato, fuso de São Paulo.
describe('prazo de compatibilidade do solicitante do cancelamento', () => {
  afterEach(() => vi.useRealTimers());

  it('o instante configurado é 2026-12-01T00:00:00-03:00', () => {
    expect(new Date(LEGACY_GRACE_ENDS_AT_ISO).toISOString()).toBe('2026-12-01T03:00:00.000Z');
  });

  it('em 30/11/2026 às 23:59:59.999 (São Paulo) ainda aceita sem solicitante e marca legacy_client', () => {
    vi.useFakeTimers({ now: new Date('2026-11-30T23:59:59.999-03:00') });
    expect(parseCancelRequester({})).toMatchObject({ cancelRequester: null, cancelChannel: 'legacy_client' });
  });

  it('a partir de 01/12/2026 às 00:00:00 (São Paulo) é obrigatório (400)', () => {
    vi.useFakeTimers({ now: new Date('2026-12-01T00:00:00-03:00') });
    expect(() => parseCancelRequester({})).toThrow(/Informe quem solicitou/);
  });

  it('com solicitante informado nunca depende do prazo', () => {
    vi.useFakeTimers({ now: new Date('2027-03-01T10:00:00-03:00') });
    expect(parseCancelRequester({ cancelRequester: 'patient' }).cancelRequester).toBe('patient');
  });

  it('canal de serviço (required=false) segue opcional mesmo depois do prazo', () => {
    vi.useFakeTimers({ now: new Date('2027-03-01T10:00:00-03:00') });
    expect(parseCancelRequester({}, { required: false })).toEqual({ cancelRequester: null, cancelRequestedAt: null });
  });
});
