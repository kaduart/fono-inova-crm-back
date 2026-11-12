// Fila de leads: quem já agendou sai (12/11/2026). Ver docs/COMMERCIAL_QUEUES.md.
import { describe, it, expect } from 'vitest';
import { isClosedForQueue, phoneTail, OPERATIONAL_QUEUE_FILTER } from '../../services/commercial/commercialRules.js';

describe('isClosedForQueue', () => {
  it('lead do agendamento direto (status agendado, funil parado em novo_contato) sai da fila', () => {
    expect(isClosedForQueue({ status: 'agendado', operational: { pipeline: 'novo_contato' } })).toBe(true);
  });
  it('funil agendado / virou paciente / não fechou sai da fila', () => {
    for (const pipeline of ['agendado', 'virou_paciente', 'nao_fechou']) {
      expect(isClosedForQueue({ status: 'novo', operational: { pipeline } })).toBe(true);
    }
  });
  it('lead vinculado a paciente sai da fila', () => {
    expect(isClosedForQueue({ status: 'novo', convertedToPatient: 'abc', operational: { pipeline: 'interessado' } })).toBe(true);
  });
  it('lead em aberto continua na fila', () => {
    expect(isClosedForQueue({ status: 'novo', operational: { pipeline: 'novo_contato' } })).toBe(false);
    expect(isClosedForQueue({ status: 'lead_quente' })).toBe(false);
  });
  it('filtro do banco cobre as três regras', () => {
    expect(OPERATIONAL_QUEUE_FILTER.status.$nin).toContain('agendado');
    expect(OPERATIONAL_QUEUE_FILTER['operational.pipeline'].$nin).toContain('agendado');
    expect(OPERATIONAL_QUEUE_FILTER.convertedToPatient).toEqual({ $in: [null, undefined] });
  });
});

describe('phoneTail', () => {
  it('casa telefone do lead (55+DDD) com o do paciente (com máscara, sem 55)', () => {
    expect(phoneTail('5562986315987')).toBe(phoneTail('(62) 98631-5987'));
    expect(phoneTail('5562986315987')).toBe('86315987');
  });
  it('telefone curto ou vazio não casa', () => {
    expect(phoneTail('')).toBeNull();
    expect(phoneTail('12345')).toBeNull();
    expect(phoneTail(null)).toBeNull();
  });
});
