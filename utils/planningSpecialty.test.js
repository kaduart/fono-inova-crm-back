import { describe, it, expect } from 'vitest';
import { toSpecialtySlug, normalizeBySpecialty, computeSpecialtyActuals } from './planningSpecialty.js';

describe('planningSpecialty', () => {
  it('converte rótulo livre antigo no slug da agenda', () => {
    expect(toSpecialtySlug('Terapia Ocupacional')).toBe('terapia_ocupacional');
    expect(toSpecialtySlug('Fonoaudiologia')).toBe('fonoaudiologia');
    expect(toSpecialtySlug('psicologia')).toBe('psicologia');
    expect(toSpecialtySlug('')).toBe('');
  });

  it('guarda sessões e receita que o front manda e junta repetidas', () => {
    const out = normalizeBySpecialty([
      { specialty: 'fonoaudiologia', sessions: 40, revenue: 8000 },
      { specialty: 'Fonoaudiologia', sessions: 10, revenue: 2000 },
      { specialty: 'psicologia', targetSessions: 20, targetRevenue: 4000 },
      { specialty: '', sessions: 5 },
    ]);
    expect(out).toEqual([
      { specialty: 'fonoaudiologia', targetSessions: 50, targetRevenue: 10000, completedSessions: 0, actualRevenue: 0 },
      { specialty: 'psicologia', targetSessions: 20, targetRevenue: 4000, completedSessions: 0, actualRevenue: 0 },
    ]);
  });

  it('preserva o realizado ao editar a meta', () => {
    const out = normalizeBySpecialty([{ specialty: 'psicologia', sessions: 30, revenue: 6000 }],
      [{ specialty: 'psicologia', completedSessions: 12, actualRevenue: 2640 }]);
    expect(out[0]).toMatchObject({ targetSessions: 30, completedSessions: 12, actualRevenue: 2640 });
  });

  it('calcula realizado por especialidade a partir dos atendimentos concluídos', () => {
    const out = computeSpecialtyActuals(
      [{ specialty: 'fonoaudiologia', targetSessions: 10, targetRevenue: 2000 }, { specialty: 'Psicologia', targetSessions: 5, targetRevenue: 1000 }],
      [
        { specialty: 'fonoaudiologia', sessionValue: 180 },
        { specialty: 'fonoaudiologia', sessionValue: 220 },
        { specialty: 'terapia_ocupacional', sessionValue: 200 },
      ],
    );
    expect(out[0]).toMatchObject({ specialty: 'fonoaudiologia', completedSessions: 2, actualRevenue: 400 });
    expect(out[1]).toMatchObject({ specialty: 'psicologia', completedSessions: 0, actualRevenue: 0 });
  });
});
