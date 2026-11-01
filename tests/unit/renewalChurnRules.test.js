import { describe, it, expect } from 'vitest';
import {
  packagesEnding, renewalThreshold, renewalStage, churnRisk, churnMessage,
} from '../../services/commercial/commercialRules.js';

describe('pacote a 80% (renovação)', () => {
  it('limite é 20% das sessões, com piso de 1', () => {
    expect(renewalThreshold(12)).toBe(2);
    expect(renewalThreshold(8)).toBe(1);
    expect(renewalThreshold(4)).toBe(1);
    expect(renewalThreshold(20)).toBe(4);
    expect(renewalThreshold(0)).toBe(1);
    expect(renewalThreshold(undefined)).toBe(1);
  });

  it('modo auto dispara em 10/12 e em 3/4', () => {
    const out = packagesEnding([
      { patient: 'a', specialty: 'fono', totalSessions: 12, sessionsDone: 10 },
      { patient: 'b', specialty: 'fono', totalSessions: 12, sessionsDone: 9 },
      { patient: 'c', specialty: 'to', totalSessions: 4, sessionsDone: 3 },
      { patient: 'd', specialty: 'to', totalSessions: 4, sessionsDone: 2 },
    ], 'auto');
    expect(out.map(e => [e.pkg.patient, e.remaining])).toEqual([['a', 2], ['c', 1]]);
  });

  it('threshold numérico continua com o limite fixo antigo', () => {
    const out = packagesEnding([
      { patient: 'd', specialty: 'to', totalSessions: 4, sessionsDone: 2 },
    ], 2);
    expect(out).toHaveLength(1);
  });

  it('estágio do chip: ok, renovar, ultima', () => {
    expect(renewalStage(5, 12)).toBe('ok');
    expect(renewalStage(2, 12)).toBe('renovar');
    expect(renewalStage(1, 12)).toBe('ultima');
    expect(renewalStage(0, 4)).toBe('ultima');
    expect(renewalStage(2, 4)).toBe('ok');
  });
});

describe('risco de evasão (churn)', () => {
  const base = (id, daysSince) => ({ patientId: id, name: `Paciente ${id}`, daysSince });
  const ctx = (over = {}) => ({
    activePatients: new Set(['a', 'b', 'c', 'd', 'e']),
    frequencyByPatient: {},
    justified: new Set(),
    paused: new Set(),
    ...over,
  });

  it('entra com 14 dias ou mais (semanal), mais antigo primeiro', () => {
    const out = churnRisk([base('a', 13), base('b', 14), base('c', 30)], ctx());
    expect(out.map(c => c.patientId)).toEqual(['c', 'b']);
    expect(out[0].severity).toBe('critical');
    expect(out[1].title).toBe('Risco de evasão: Paciente b está sem agendamento há 14 dias');
  });

  it('quinzenal só entra com 21 dias', () => {
    const out = churnRisk([base('a', 20), base('b', 21)], ctx({ frequencyByPatient: { a: 'biweekly', b: 'biweekly' } }));
    expect(out.map(c => c.patientId)).toEqual(['b']);
  });

  it('tira inativo, falta justificada e pausa vigente', () => {
    const out = churnRisk(
      [base('a', 20), base('b', 20), base('c', 20), base('x', 20)],
      ctx({ justified: new Set(['a']), paused: new Set(['b']) }),
    );
    expect(out.map(c => c.patientId)).toEqual(['c']);
  });

  it('mensagem usa o primeiro nome, horário genérico e sem preço', () => {
    const msg = churnMessage('João Pedro Silva');
    expect(msg).toContain('Sentimos falta de João');
    expect(msg).toMatch(/manhã ou à tarde/);
    expect(msg).not.toMatch(/R\$/);
    expect(churnMessage('')).toContain('Sentimos falta de vocês');
  });
});
