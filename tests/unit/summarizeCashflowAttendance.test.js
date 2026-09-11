import { describe, expect, it } from 'vitest';
import { summarizeCashflowAttendance } from '../../services/appointment/policies/summarizeCashflowAttendance.js';

describe('summarizeCashflowAttendance', () => {
  it('separa atendidos e aguardando sem contar cancelamentos, faltas ou pré-agendamentos', () => {
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
      faltantes: 5,
      total: 7
    });
  });

  it('retorna contagens zeradas para um período sem agenda', () => {
    expect(summarizeCashflowAttendance([])).toEqual({ realizados: 0, faltantes: 0, total: 0 });
  });
});
