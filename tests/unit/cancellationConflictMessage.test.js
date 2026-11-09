import { describe, expect, it } from 'vitest';
import { buildCancellationConflictMessage, describeExistingAppointment } from '../../domain/appointment/cancellationConflictMessage.js';

describe('buildCancellationConflictMessage', () => {
  it('diz a data e o que já está lançado no horário', () => {
    const out = buildCancellationConflictMessage([
      { date: '2026-10-02', time: '10:40', specialty: 'terapia_ocupacional', action: 'conflict',
        existing: [{ specialty: 'fonoaudiologia', doctorName: 'Lorrany', guideNumber: '0020', status: 'pre_agendado' }] },
    ]);
    expect(out.title).toMatch(/1 data cancelada/);
    expect(out.message).toContain('02/10/2026 às 10:40 — já existe Fonoaudiologia com Lorrany (guia 0020), pré-agendado');
    expect(out.message).toContain('Nada foi salvo');
    expect(out.items[0].existing).toHaveLength(1);
    expect(out.message).not.toMatch(/[a-f\d]{24}/);
  });

  it('lista no máximo 5 e resume o resto', () => {
    const conflicts = Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-0${i + 1}`, time: '10:40', message: 'Já existe atendimento nesse horário.' }));
    const out = buildCancellationConflictMessage(conflicts);
    expect(out.title).toMatch(/7 datas/);
    expect(out.message).toContain('• e mais 2');
    expect(out.items).toHaveLength(7);
  });

  it('sessão realizada pede correção administrativa', () => {
    const out = buildCancellationConflictMessage([{ date: '2026-10-02', time: '10:40', code: 'COMPLETED_CANCELLATION_BLOCKED', message: 'x' }]);
    expect(out.action).toMatch(/administrativo/);
  });

  it('descreve liminar sem guia', () => {
    expect(describeExistingAppointment({ specialty: 'psicologia', liminar: true, status: 'completed' })).toBe('Psicologia (liminar), realizado');
  });
});
