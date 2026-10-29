import { beforeEach, describe, expect, it, vi } from 'vitest';

// Lista "Meus pacientes" do painel do terapeuta: status de atendimento, filtros e ordenação.
const mocks = vi.hoisted(() => {
  const state = { appointments: [], patients: [], lastPatientFilter: null };
  const query = value => ({ select() { return this; }, lean: async () => value });
  return { state, query };
});
vi.mock('../../models/Appointment.js', () => ({ default: { find: () => mocks.query(mocks.state.appointments) } }));
vi.mock('../../models/Patient.js', () => ({ default: { find: f => { mocks.state.lastPatientFilter = f; return mocks.query(mocks.state.patients); } } }));
vi.mock('../../models/Doctor.js', () => ({ default: {} }));
vi.mock('../../models/Session.js', () => ({ default: {} }));
vi.mock('../../models/TherapySession.js', () => ({ default: {} }));
import { getDoctorPatients } from '../../controllers/doctorController.js';

const DOC = '68bedf1104ec4875aaea8188';
const day = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const run = async (query = {}) => {
  let body; const res = { json: b => { body = b; return res; }, status() { return res; } };
  await getDoctorPatients({ user: { id: DOC }, query }, res);
  return body;
};

beforeEach(() => {
  mocks.state.patients = [
    { _id: 'p1', fullName: 'Bruno', dateOfBirth: new Date(Date.UTC(2018, new Date().getMonth(), 3)) },
    { _id: 'p2', fullName: 'Ana' },
    { _id: 'p3', fullName: 'Carla' },
    { _id: 'p4', fullName: 'Davi' },
  ];
  mocks.state.appointments = [
    { patient: 'p1', date: day(2), time: '10:00', operationalStatus: 'pre_agendado', billingType: 'convenio', insuranceProvider: 'Unimed' },
    { patient: 'p1', date: day(-7), time: '10:00', operationalStatus: 'completed' },
    { patient: 'p2', date: day(1), time: '09:00', operationalStatus: 'scheduled' },
    { patient: 'p3', date: day(-10), time: '14:00', operationalStatus: 'completed', liminarContract: 'lc1', billingType: 'liminar' },
    { patient: 'p4', date: day(-90), time: '14:00', operationalStatus: 'completed' },
    { patient: 'p4', date: day(3), time: '14:00', operationalStatus: 'missed' },
  ];
});

describe('getDoctorPatients', () => {
  it('calcula status de atendimento e o resumo dos filtros', async () => {
    const body = await run();
    const by = Object.fromEntries(body.data.map(p => [p._id, p]));
    expect(by.p1.careStatus).toBe('active'); // pre_agendado conta como sessão futura
    expect(by.p3.careStatus).toBe('no_next');
    expect(by.p4.careStatus).toBe('inactive'); // falta futura não é sessão marcada
    expect(by.p1.billingType).toBe('convenio');
    expect(by.p3.hasLiminar).toBe(true);
    expect(by.p1.completedSessions).toBe(1);
    expect(body.meta.summary).toEqual({ total: 4, active: 2, no_next: 1, inactive: 1, birthday: 1 });
  });

  it('ordena por próxima sessão e depois pelos sem agendamento mais recentes', async () => {
    const body = await run();
    expect(body.data.map(p => p._id)).toEqual(['p2', 'p1', 'p3', 'p4']);
  });

  it('filtra por status, aniversário e ids, mantendo o resumo geral', async () => {
    expect((await run({ care: 'no_next' })).data.map(p => p._id)).toEqual(['p3']);
    expect((await run({ care: 'birthday' })).data.map(p => p._id)).toEqual(['p1']);
    const byIds = await run({ ids: 'p4,p2' });
    expect(byIds.data.map(p => p._id)).toEqual(['p2', 'p4']);
    expect(byIds.meta.summary.total).toBe(4);
  });

  it('busca por nome, responsável ou telefone formatado', async () => {
    await run({ search: '6299 999' });
    const or = mocks.state.lastPatientFilter.$or;
    expect(or).toHaveLength(3);
    expect(new RegExp(or[2].phone.$regex).test('(62) 99999-0000')).toBe(true);
  });
});
