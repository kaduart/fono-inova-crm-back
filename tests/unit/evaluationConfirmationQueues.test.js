// Filas "Avaliou e não fechou" e "Próximo dia útil sem confirmação" (31/10/2026).
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { pickEvaluationsWithoutPackage, confirmationState, confirmationReminderText } from '../../services/commercial/evaluationConfirmationQueues.js';

const oid = (d) => mongoose.Types.ObjectId.createFromTime(Math.floor(new Date(d).getTime() / 1000));

describe('pickEvaluationsWithoutPackage', () => {
  const ev = (patient, date) => ({ patient, date: new Date(date) });

  it('mantém quem avaliou e não tem pacote nem sessão futura', () => {
    expect(pickEvaluationsWithoutPackage([ev('p1', '2026-10-20')], {})).toHaveLength(1);
  });
  it('tira quem criou pacote depois da avaliação', () => {
    const packages = [{ patient: 'p1', status: 'completed', _id: oid('2026-10-22') }];
    expect(pickEvaluationsWithoutPackage([ev('p1', '2026-10-20')], { packages })).toHaveLength(0);
  });
  it('mantém quem só tem pacote antigo já encerrado', () => {
    const packages = [{ patient: 'p1', status: 'finished', _id: oid('2026-03-01') }];
    expect(pickEvaluationsWithoutPackage([ev('p1', '2026-10-20')], { packages })).toHaveLength(1);
  });
  it('tira quem tem pacote ativo, sessão futura ou foi marcado como perdido', () => {
    const evals = [ev('p1', '2026-10-20'), ev('p2', '2026-10-20'), ev('p3', '2026-10-20')];
    const r = pickEvaluationsWithoutPackage(evals, {
      packages: [{ patient: 'p1', status: 'active', _id: oid('2026-01-01') }],
      futurePatientIds: new Set(['p2']),
      lostPatientIds: new Set(['p3']),
    });
    expect(r).toHaveLength(0);
  });
});

describe('confirmationState', () => {
  it('classifica sem telefone, não enviado, sem resposta e pediu remarcar', () => {
    expect(confirmationState({}, '')).toBe('no_phone');
    expect(confirmationState({ attendanceConfirmation: { status: 'pending' } }, '62999')).toBe('not_sent');
    expect(confirmationState({ attendanceConfirmation: { status: 'pending', sentAt: new Date() } }, '62999')).toBe('no_reply');
    expect(confirmationState({ attendanceConfirmation: { status: 'change_requested' } }, '62999')).toBe('change_requested');
  });
});

describe('confirmationReminderText', () => {
  it('usa o primeiro nome, o dia da semana e a hora', () => {
    const t = confirmationReminderText({ name: 'Arthur Silva', date: '2026-11-02', time: '08:00', doctorName: 'Dra. Luana' });
    expect(t).toContain('de Arthur na segunda-feira, 02/11, às 08:00, com Dra. Luana');
  });
});
