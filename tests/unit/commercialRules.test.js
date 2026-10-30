import { describe, it, expect } from 'vitest';
import {
  normalizeArea, waitingSince, sortFitLeads, packagesEnding, sortByRecentContact,
} from '../../services/commercial/commercialRules.js';

describe('commercialRules', () => {
  it('normaliza área do lead para a especialidade do profissional', () => {
    expect(normalizeArea('Fonoaudiologia')).toBe('fonoaudiologia');
    expect(normalizeArea('Terapia Ocupacional')).toBe('terapia_ocupacional');
    expect(normalizeArea('neuropsychological')).toBe('neuropsicologia');
    expect(normalizeArea('Psicóloga')).toBe('psicologia');
    expect(normalizeArea(null)).toBe('');
  });

  it('lead espera resposta só quando ele falou por último', () => {
    const t = '2026-10-30T10:00:00Z';
    expect(waitingSince({ createdAt: t, lastMessage: { direction: 'inbound', timestamp: t } })?.toISOString()).toBe('2026-10-30T10:00:00.000Z');
    expect(waitingSince({ createdAt: t, lastMessage: { direction: 'outbound', timestamp: t } })).toBeNull();
    expect(waitingSince({ createdAt: t, lastInteraction: { direction: 'outbound', date: t } })).toBeNull();
    expect(waitingSince({ createdAt: t })?.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('encaixe prioriza lista de espera e lead quente', () => {
    const out = sortFitLeads([
      { status: 'novo', lastInteractionAt: '2026-10-30' },
      { status: 'lead_quente', lastInteractionAt: '2026-10-01' },
      { status: 'lista_espera', lastInteractionAt: '2026-09-01' },
    ]);
    expect(out.map(l => l.status)).toEqual(['lista_espera', 'lead_quente', 'novo']);
  });

  it('pacote acabando ignora quem já renovou na mesma especialidade', () => {
    const out = packagesEnding([
      { patient: 'a', specialty: 'fonoaudiologia', totalSessions: 4, sessionsDone: 3 },
      { patient: 'a', specialty: 'fonoaudiologia', totalSessions: 4, sessionsDone: 0 },
      { patient: 'b', specialty: 'psicologia', totalSessions: 4, sessionsDone: 2 },
      { patient: 'c', specialty: 'psicologia', totalSessions: 4, sessionsDone: 5 },
    ], 2);
    expect(out.map(e => [e.pkg.patient, e.remaining])).toEqual([['b', 2], ['c', 0]]);
  });

  it('contato recente vai para o fim sem sumir', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    const out = sortByRecentContact([
      { id: 1, lastContactAt: '2026-10-29T12:00:00Z' },
      { id: 2, lastContactAt: null },
      { id: 3, lastContactAt: '2026-10-01T12:00:00Z' },
    ], now);
    expect(out.map(i => i.id)).toEqual([2, 3, 1]);
  });
});
