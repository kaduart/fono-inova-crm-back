import { beforeEach, describe, expect, it, vi } from 'vitest';

// Insights do terapeuta: frequência por paciente na janela pedida, lida dos agendamentos.
const mocks = vi.hoisted(() => {
  const state = { appointments: [], patients: [] };
  const query = value => ({ select() { return this; }, lean: async () => value });
  const inRange = (a, r) => !r || ((!r.$gte || a.date >= r.$gte) && (!r.$lte || a.date <= r.$lte));
  return { state, query, inRange };
});
vi.mock('../../models/Appointment.js', () => ({
  default: {
    find: f => mocks.query(mocks.state.appointments.filter(a => mocks.inRange(a, f.date))),
    aggregate: async pipeline => {
      const m = pipeline[0].$match;
      const rows = mocks.state.appointments.filter(a => mocks.inRange(a, m.date)
        && (typeof m.operationalStatus === 'string' ? a.operationalStatus === m.operationalStatus : m.operationalStatus.$in.includes(a.operationalStatus)));
      const by = new Map();
      for (const a of rows.sort((x, y) => x.date - y.date)) {
        const cur = by.get(a.patient);
        if (m.operationalStatus === 'completed') by.set(a.patient, { _id: a.patient, date: a.date });
        else if (!cur) by.set(a.patient, { _id: a.patient, date: a.date, time: a.time });
      }
      return [...by.values()];
    },
  },
}));
vi.mock('../../models/Patient.js', () => ({ default: { find: () => mocks.query(mocks.state.patients) } }));
vi.mock('../../models/Doctor.js', () => ({ default: {} }));
vi.mock('../../models/Session.js', () => ({ default: {} }));
vi.mock('../../models/TherapySession.js', () => ({ default: {} }));
vi.mock('mongoose', async () => {
  const actual = await vi.importActual('mongoose');
  const ObjectId = function (id) { return id; };
  ObjectId.isValid = () => true;
  return { ...actual, default: { ...actual.default, Types: { ObjectId } } };
});
import { attendanceWindows, getAtendencePatient } from '../../controllers/doctorController.js';

const DOC = '68bedf1104ec4875aaea8188';
const day = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const run = async (query = {}) => {
  let body; const res = { json: b => { body = b; return res; }, status() { return res; } };
  await getAtendencePatient({ params: { id: DOC }, query }, res);
  return body;
};

beforeEach(() => {
  mocks.state.patients = [{ _id: 'p1', fullName: 'Ana', phone: '62999990000' }, { _id: 'p2', fullName: 'Bruno' }];
  mocks.state.appointments = [
    { patient: 'p1', date: day(-3), operationalStatus: 'completed' },
    { patient: 'p1', date: day(-10), operationalStatus: 'completed' },
    { patient: 'p1', date: day(-17), operationalStatus: 'missed' },
    { patient: 'p1', date: day(-20), operationalStatus: 'canceled', cancelRequester: 'patient' },
    { patient: 'p1', date: day(4), time: '10:00', operationalStatus: 'scheduled' },
    { patient: 'p2', date: day(-5), operationalStatus: 'completed' },
    { patient: 'p2', date: day(-6), operationalStatus: 'canceled' },
    { patient: 'p2', date: day(-45), operationalStatus: 'completed' }, // fora dos 30 dias, dentro do período anterior
  ];
});

describe('getAtendencePatient', () => {
  it('conta falta como missed e frequência = realizadas ÷ previstas até hoje', async () => {
    const body = await run({ range: '30d' });
    const ana = body.data.find(d => d.patient._id === 'p1');
    expect(ana).toMatchObject({ total: 4, attended: 2, missed: 1, canceled: 1, pending: 0, expected: 3, frequency: 67 }); // a sessão futura fica fora da janela;
    expect(ana.nextAppointment).toMatchObject({ time: '10:00' });
    expect(ana.patient.phone).toBe('62999990000');
    const bruno = body.data.find(d => d.patient._id === 'p2');
    expect(bruno).toMatchObject({ total: 2, attended: 1, canceled: 1, expected: 1, frequency: 100, nextAppointment: null });
  });

  it('devolve o resumo do período, quem cancelou e o período anterior', async () => {
    const body = await run({ range: '30d' });
    expect(body.meta.range).toBe('30d');
    expect(body.meta.summary).toMatchObject({ total: 6, attended: 3, missed: 1, canceled: 2, expected: 4, attendanceRate: 75, patients: 2 });
    expect(body.meta.summary.canceledBy).toEqual({ patient: 1, professional: 0, clinic: 0, unknown: 1 });
    expect(body.meta.previous).toMatchObject({ total: 1, attended: 1, attendanceRate: 100 });
  });

  it('janelas: mês atual compara com o mesmo trecho do mês anterior; range inválido vira mês', () => {
    const now = new Date(2026, 9, 29, 15, 0);
    const m = attendanceWindows('month', now);
    expect([m.start.getMonth(), m.start.getDate()]).toEqual([9, 1]);
    expect([m.prevStart.getMonth(), m.prevEnd.getMonth(), m.prevEnd.getDate()]).toEqual([8, 8, 29]);
    const last = attendanceWindows('last_month', now);
    expect([last.start.getMonth(), last.end.getMonth(), last.end.getDate()]).toEqual([8, 8, 30]);
    expect(attendanceWindows('xpto', now).range).toBe('month');
    const d30 = attendanceWindows('30d', now);
    expect(Math.round((d30.prevEnd - d30.prevStart) / 86400000)).toBe(30);
  });
});
