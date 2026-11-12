// Rede de segurança da fila de leads: lead cujo paciente (mesmo telefone) já agendou sai da fila.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const patientFind = vi.fn();
const apptAggregate = vi.fn();
vi.mock('../../models/Patient.js', () => ({ default: { find: (...a) => ({ lean: () => patientFind(...a) }) } }));
vi.mock('../../models/Appointment.js', () => ({ default: { aggregate: (...a) => apptAggregate(...a) } }));

const { leadIdsWithAppointment, withoutScheduledLeads } = await import('../../services/commercial/leadQueue.js');

const now = new Date('2026-11-12T20:00:00Z');
const lead = (id, phone, createdAt = '2026-11-01T00:00:00Z') => ({ _id: id, contact: { phone }, createdAt: new Date(createdAt) });

beforeEach(() => { patientFind.mockReset(); apptAggregate.mockReset(); });

describe('leadIdsWithAppointment', () => {
  it('sessão futura do paciente tira o lead (telefone com máscara e sem 55)', async () => {
    patientFind.mockResolvedValue([{ _id: 'p1', phone: '(62) 98631-5987' }]);
    apptAggregate.mockResolvedValue([{ _id: 'p1', lastCreatedAt: new Date('2026-10-01'), hasFuture: true }]);
    const out = await leadIdsWithAppointment([lead('L1', '5562986315987'), lead('L2', '5562900000000')], now);
    expect([...out]).toEqual(['L1']);
  });

  it('agendamento criado depois do lead tira o lead, mesmo sem sessão futura', async () => {
    patientFind.mockResolvedValue([{ _id: 'p1', phone: '62986315987' }]);
    apptAggregate.mockResolvedValue([{ _id: 'p1', lastCreatedAt: new Date('2026-11-05'), hasFuture: false }]);
    expect([...(await leadIdsWithAppointment([lead('L1', '5562986315987')], now))]).toEqual(['L1']);
  });

  it('ex-paciente que voltou como lead novo (só agendamentos antigos) continua na fila', async () => {
    patientFind.mockResolvedValue([{ _id: 'p1', phone: '62986315987' }]);
    apptAggregate.mockResolvedValue([{ _id: 'p1', lastCreatedAt: new Date('2025-03-01'), hasFuture: false }]);
    expect((await leadIdsWithAppointment([lead('L1', '5562986315987')], now)).size).toBe(0);
  });

  it('sem telefone não consulta o banco', async () => {
    expect((await leadIdsWithAppointment([lead('L1', '')], now)).size).toBe(0);
    expect(patientFind).not.toHaveBeenCalled();
  });

  it('withoutScheduledLeads devolve só quem segue em aberto', async () => {
    patientFind.mockResolvedValue([{ _id: 'p1', phone: '62986315987' }]);
    apptAggregate.mockResolvedValue([{ _id: 'p1', lastCreatedAt: new Date('2026-11-05'), hasFuture: true }]);
    const kept = await withoutScheduledLeads([lead('L1', '5562986315987'), lead('L2', '5562911112222')], now);
    expect(kept.map((l) => l._id)).toEqual(['L2']);
  });
});
