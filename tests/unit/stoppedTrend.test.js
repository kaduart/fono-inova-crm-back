import { describe, it, expect } from 'vitest';
import { stoppedTrend } from '../../services/commercial/commercialRules.js';

const at = (ym, day = 10) => new Date(`${ym}-${String(day).padStart(2, '0')}T15:00:00Z`);
const many = (ym, n, extra = {}) => Array.from({ length: n }, () => ({ lastSessionAt: at(ym), ...extra }));

describe('stoppedTrend', () => {
  const now = new Date('2026-11-07T12:00:00Z');

  it('conta por mês, ignora o mês atual e meses fora da janela', () => {
    const rows = [...many('2026-10', 2), ...many('2026-11', 9), ...many('2025-01', 4), ...many('2026-03', 3)];
    const { months } = stoppedTrend(rows, { now, months: 6 });
    expect(months.map(m => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(months.find(m => m.month === '2026-10').count).toBe(2);
    expect(months.reduce((a, m) => a + m.count, 0)).toBe(2);
    // março entra só na média de maio (3 meses antes), não na lista
    expect(months.find(m => m.month === '2026-05').baseline).toBe(1);
  });

  it('marca pico quando passa de 1,5x a média dos 3 meses anteriores (mínimo 5)', () => {
    const rows = [...many('2026-03', 10), ...many('2026-04', 10), ...many('2026-05', 10), ...many('2026-06', 40, { specialty: 'fonoaudiologia', doctorName: 'Dra. X' })];
    const { months } = stoppedTrend(rows, { now: new Date('2026-08-05T12:00:00Z'), months: 6 });
    const jun = months.find(m => m.month === '2026-06');
    expect(jun.baseline).toBe(10);
    expect(jun.spike).toBe(true);
    expect(jun.bySpecialty[0]).toEqual({ label: 'fonoaudiologia', value: 40 });
    expect(months.find(m => m.month === '2026-05').spike).toBe(false);
  });

  it('não alerta com volume pequeno e só alerta picos dos últimos 3 meses', () => {
    const small = stoppedTrend([...many('2026-09', 1), ...many('2026-10', 4)], { now, months: 6 });
    expect(small.alert).toBeNull();
    const old = stoppedTrend([...many('2026-04', 1), ...many('2026-05', 30)], { now, months: 6 });
    expect(old.months.find(m => m.month === '2026-05').spike).toBe(true);
    expect(old.alert).toBeNull();
    const recent = stoppedTrend([...many('2026-07', 2), ...many('2026-08', 20)], { now, months: 6 });
    expect(recent.alert.month).toBe('2026-08');
  });
});
