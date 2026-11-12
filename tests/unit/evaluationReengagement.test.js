// "Retomar contato" pós-avaliação sem continuidade (12/11/2026).
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { pickWithoutContinuity, buildReengageText, periodRange, ALL_MIN_DAYS } from '../../services/commercial/evaluationReengagement.js';

const oid = (d) => mongoose.Types.ObjectId.createFromTime(Math.floor(new Date(d).getTime() / 1000));

describe('pickWithoutContinuity', () => {
  const ev = (patient, date, _id = `ev-${patient}`) => ({ _id, patient, date: new Date(date) });

  it('mantém quem avaliou e não tem sessão nem pacote depois', () => {
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], {})).toHaveLength(1);
  });
  it('tira quem teve sessão (realizada ou marcada) depois da avaliação', () => {
    const later = [{ _id: 'a1', patient: 'p1', date: new Date('2026-06-08') }];
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], { later })).toHaveLength(0);
  });
  it('sessão ANTES da avaliação não conta como continuidade', () => {
    const later = [{ _id: 'a0', patient: 'p1', date: new Date('2026-05-01') }];
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], { later })).toHaveLength(1);
  });
  it('a própria avaliação não conta', () => {
    const later = [{ _id: 'ev-p1', patient: 'p1', date: new Date('2026-06-01') }];
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], { later })).toHaveLength(1);
  });
  it('tira quem criou pacote depois da avaliação (ou na véspera) e quem tem pacote ativo', () => {
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], { packages: [{ patient: 'p1', status: 'finished', _id: oid('2026-06-03') }] })).toHaveLength(0);
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], { packages: [{ patient: 'p1', status: 'finished', _id: oid('2026-05-31T12:00:00Z') }] })).toHaveLength(0);
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], { packages: [{ patient: 'p1', status: 'active', _id: oid('2025-01-01') }] })).toHaveLength(0);
  });
  it('pacote antigo encerrado não impede', () => {
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], { packages: [{ patient: 'p1', status: 'finished', _id: oid('2025-01-01') }] })).toHaveLength(1);
  });
  it('tira quem tem sessão futura', () => {
    expect(pickWithoutContinuity([ev('p1', '2026-06-01')], { futurePatientIds: new Set(['p1']) })).toHaveLength(0);
  });
});

describe('periodRange', () => {
  it('all = todo o histórico, sem pegar avaliação de poucos dias', () => {
    expect(periodRange('all')).toEqual({ period: 'all', minDays: ALL_MIN_DAYS, maxDays: null });
  });
  it('15/30/60 = avaliou há mais de N dias', () => {
    expect(periodRange('30')).toEqual({ period: 30, minDays: 30, maxDays: null });
    expect(periodRange(60).minDays).toBe(60);
  });
  it('recusa outro período', () => {
    expect(() => periodRange(7)).toThrow();
  });
});

describe('buildReengageText', () => {
  it('cita o paciente, a especialidade e o responsável', () => {
    const t = buildReengageText({ patientNames: ['JOÃO PEDRO SILVA'], guardian: 'maria souza', specialty: 'fonoaudiologia', atendente: 'Bia' });
    expect(t).toContain('Oi, Maria!');
    expect(t).toContain('Aqui é a Bia, da *Clínica Fono Inova!*');
    expect(t).toContain('avaliação de *fonoaudiologia* com *João*');
    expect(t).toContain('como João está');
  });
  it('irmãos no mesmo telefone: uma mensagem com os dois nomes', () => {
    const t = buildReengageText({ patientNames: ['Ana', 'Lucas'] });
    expect(t).toContain('com *Ana e Lucas*');
    expect(t).toContain('como eles estão');
    expect(t).toContain('Oi! Tudo bem?');
  });
});
