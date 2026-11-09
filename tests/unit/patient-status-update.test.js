import { describe, it, expect } from 'vitest';
import { buildPatientStatusUpdate } from '../../domain/patient/buildPatientStatusUpdate.js';

const now = new Date('2026-11-09T18:00:00Z');
const user = { id: 'u1', name: 'Recepção' };

describe('buildPatientStatusUpdate', () => {
  it('inativa com motivo, observação, data e quem fez', () => {
    const set = buildPatientStatusUpdate({ status: 'inactive', reason: 'financeiro', note: '  achou caro  ', user, now });
    expect(set.status).toBe('inactive');
    expect(set['inactivation.reason']).toBe('financeiro');
    expect(set['inactivation.note']).toBe('achou caro');
    expect(set['inactivation.at']).toBe(now);
    expect(set['inactivation.by']).toBe('u1');
    expect(set['inactivation.byName']).toBe('Recepção');
    expect(set['inactivation.reactivatedAt']).toBeNull();
  });

  it('recusa inativar sem motivo ou com motivo fora da lista', () => {
    expect(() => buildPatientStatusUpdate({ status: 'inactive', user, now })).toThrow(/motivo/);
    try {
      buildPatientStatusUpdate({ status: 'inactive', reason: 'qualquer', user, now });
    } catch (e) {
      expect(e.code).toBe('PATIENT_INACTIVATION_REASON_REQUIRED');
      expect(e.status).toBe(400);
    }
  });

  it('reativar guarda o histórico do motivo e marca a volta', () => {
    const set = buildPatientStatusUpdate({ status: 'active', user, now, current: { status: 'inactive' } });
    expect(set.status).toBe('active');
    expect(set['inactivation.reactivatedAt']).toBe(now);
    expect(set['inactivation.reason']).toBeUndefined();
  });

  it('recusa status desconhecido', () => {
    expect(() => buildPatientStatusUpdate({ status: 'lead', user, now })).toThrow(/Status inválido/);
  });
});
