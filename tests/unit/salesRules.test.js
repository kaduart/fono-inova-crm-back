import { describe, it, expect } from 'vitest';
import { parsePeriod, phoneVariants, channelOf, leadFunnel, channelVerdict, roiTotals, pct } from '../../services/commercial/salesRules.js';

describe('salesRules', () => {
  it('período usa o dia inteiro em São Paulo e calcula o anterior de mesmo tamanho', () => {
    const p = parsePeriod('2026-10-01', '2026-10-30');
    expect(p.start.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-31T02:59:59.999Z');
    expect(p.days).toBe(30);
    expect(p.prevStart.toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });

  it('período inválido cai no mês corrente', () => {
    const p = parsePeriod('xx', null, new Date('2026-10-15T15:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });

  it('telefone gera as formas com e sem DDI', () => {
    expect(phoneVariants('(62) 99201-3573')).toEqual(['62992013573', '5562992013573']);
    expect(phoneVariants('5562992013573')).toEqual(['5562992013573', '62992013573']);
    expect(phoneVariants('123')).toEqual([]);
  });

  it('canal prefere a atribuição e normaliza a origem livre', () => {
    expect(channelOf('meta_ads', 'Instagram')).toBe('facebook_ads');
    expect(channelOf(null, 'Instagram')).toBe('instagram');
    expect(channelOf('unknown', 'Google Meu Negócio')).toBe('gmb');
    expect(channelOf(null, 'Indicação')).toBe('indicacao');
    expect(channelOf(null, null)).toBe('desconhecido');
  });

  it('funil soma etapas e receita', () => {
    const f = leadFunnel([
      { conversed: true, scheduled: true, attended: true, pack: true, revenue: 720 },
      { conversed: true, scheduled: false, attended: false, pack: false, revenue: 0 },
      { conversed: false },
    ]);
    expect(f).toEqual({ leads: 3, conversed: 2, scheduled: 1, attended: 1, pack: 1, revenue: 720 });
    expect(pct(1, 3)).toBe(33.3);
  });

  it('ROI: custo por paciente só com gasto e paciente', () => {
    expect(roiTotals({ spend: 1800, leads: 64, patients: 7, revenue: 6120 }))
      .toEqual({ spend: 1800, leads: 64, patients: 7, revenue: 6120, costPerLead: 28.13, costPerPatient: 257.14, returnMultiple: 3.4 });
    expect(roiTotals({ spend: 0, leads: 5, patients: 1, revenue: 720 }).costPerPatient).toBeNull();
    expect(channelVerdict({ spend: 600, leads: 12, patients: 0 }).tone).toBe('red');
    expect(channelVerdict({ spend: 0, leads: 14, patients: 2 }).text).toBe('orgânico forte');
  });
});
