// 12/11/2026: avaliação lançada como sessão avulsa/consulta = primeiro atendimento realizado do paciente.
import { describe, it, expect, vi } from 'vitest';

const rows = [
  { _id: 's2', patient: 'p1', date: new Date('2026-10-20'), serviceType: 'individual_session' }, // 2ª sessão de p1
  { _id: 's1', patient: 'p1', date: new Date('2026-10-10'), serviceType: 'individual_session' }, // 1º atendimento de p1
  { _id: 'c1', patient: 'p2', date: new Date('2026-10-15'), serviceType: 'consultation' }, // p2 já veio antes
  { _id: 'e1', patient: 'p3', date: new Date('2026-10-12'), serviceType: 'evaluation' },
  { _id: 't1', patient: 'p4', date: new Date('2026-10-11'), serviceType: 'tongue_tie_test' },
];
vi.mock('../../models/Appointment.js', () => ({
  default: {
    find: () => ({ sort: () => ({ lean: async () => rows }) }),
    aggregate: async () => [{ _id: 'p1', apptId: 's1' }, { _id: 'p2', apptId: 'antigo' }],
  },
}));
vi.mock('../../models/Patient.js', () => ({ default: {} }));
vi.mock('../../models/Package.js', () => ({ default: {} }));
vi.mock('../../models/Doctor.js', () => ({ default: {} }));
vi.mock('../../models/CommercialContact.js', () => ({ default: {} }));

const { findEvaluationLike } = await import('../../services/commercial/evaluationConfirmationQueues.js');

describe('findEvaluationLike', () => {
  it('conta o tipo avaliação e o primeiro atendimento; ignora sessão que não é a primeira', async () => {
    const out = await findEvaluationLike({ to: new Date('2026-11-01') });
    expect(out.map(e => [e.patient, String(e._id), e.firstVisit])).toEqual([
      ['p1', 's1', true], ['p3', 'e1', false], ['p4', 't1', false],
    ]);
  });
});
