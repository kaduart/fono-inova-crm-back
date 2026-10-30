import { describe, expect, it } from 'vitest';
import { summarizeCashflowAttendance, summarizeCashflowAgendaValue } from '../../services/appointment/policies/summarizeCashflowAttendance.js';

describe('summarizeCashflowAttendance', () => {
  it('separa atendidos e aguardando sem contar cancelamentos e faltas (pre_agendado conta como aguardando, ADR-006)', () => {
    const appointments = [
      { operationalStatus: 'completed' },
      { operationalStatus: 'completed', clinicalStatus: 'completed' },
      { operationalStatus: 'scheduled' },
      { operationalStatus: 'confirmed' },
      { operationalStatus: 'pending' },
      { operationalStatus: 'paid' },
      { operationalStatus: 'processing_complete' },
      { operationalStatus: 'scheduled', missed: true },
      { operationalStatus: 'confirmed', clinicalStatus: 'missed' },
      { operationalStatus: 'canceled' },
      { operationalStatus: 'force_cancelled' },
      { operationalStatus: 'suspended' },
      { operationalStatus: 'pre_agendado' },
      { operationalStatus: 'missed' }
    ];

    expect(summarizeCashflowAttendance(appointments)).toEqual({
      realizados: 2,
      faltantes: 6,
      total: 8
    });
  });

  it('retorna contagens zeradas para um período sem agenda', () => {
    expect(summarizeCashflowAttendance([])).toEqual({ realizados: 0, faltantes: 0, total: 0 });
  });
});

describe('summarizeCashflowAgendaValue', () => {
  it('soma o previsto pela valuation oficial e separa faltas e cancelamentos', () => {
    const r = summarizeCashflowAgendaValue([
      { operationalStatus: 'completed', sessionValue: 200 },
      { operationalStatus: 'pre_agendado', sessionValue: 220 },
      { operationalStatus: 'scheduled', package: { totalValue: 720, totalSessions: 4 } },
      { operationalStatus: 'scheduled', missed: true, sessionValue: 220 },
      { operationalStatus: 'canceled', package: { sessionValue: 180 } },
      { operationalStatus: 'converted', sessionValue: 999 },
    ]);
    expect(r).toEqual({ previsto: 600, sessoes: 3, perdido: 400, faltasOuCancelados: 2 });
  });
});
