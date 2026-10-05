import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFindById: vi.fn(),
  guideFindById: vi.fn(),
  liminarFindById: vi.fn(),
  updateExecute: vi.fn(),
}));

vi.mock('../../../models/Appointment.js', () => ({ default: { findById: mocks.appointmentFindById } }));
vi.mock('../../../models/InsuranceGuide.js', () => ({ default: { findById: mocks.guideFindById } }));
vi.mock('../../../models/LiminarContract.js', () => ({ default: { findById: mocks.liminarFindById } }));
vi.mock('./updateAppointmentCommand.js', () => ({ execute: mocks.updateExecute }));

import { execute } from './rescheduleAppointmentCommand.js';

// Mongoose query encadeada: findById(id).select(...).lean()
const query = (value) => ({ select: () => ({ lean: async () => value }) });

const future = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
};

const baseAppointment = (over = {}) => ({
  _id: 'appt-1',
  operationalStatus: 'scheduled',
  date: new Date(`${future(3)}T12:00:00.000Z`),
  time: '14:00',
  doctor: 'doc-1',
  patient: 'pat-1',
  billingType: 'particular',
  insuranceGuide: null,
  liminarContract: null,
  ...over,
});

const admin = { _id: 'user-1', role: 'admin' };

describe('rescheduleAppointmentCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateExecute.mockResolvedValue({ data: { _id: 'appt-1' } });
  });

  it('exige o id', async () => {
    await expect(execute(undefined, { date: future(5), time: '10:00' }, admin)).rejects.toMatchObject({
      code: 'MISSING_ID',
      status: 400,
    });
  });

  it('404 quando o agendamento não existe', async () => {
    mocks.appointmentFindById.mockReturnValue(query(null));
    await expect(execute('appt-1', { date: future(5), time: '10:00' }, admin)).rejects.toMatchObject({
      code: 'APPOINTMENT_NOT_FOUND',
      status: 404,
    });
    expect(mocks.updateExecute).not.toHaveBeenCalled();
  });

  it('delega ao updateAppointmentCommand com date/time/doctorId e motivo (particular)', async () => {
    mocks.appointmentFindById.mockReturnValue(query(baseAppointment()));
    const target = future(6);

    const result = await execute('appt-1', { date: target, time: '9:00', reason: 'Paciente pediu' }, admin);

    expect(mocks.updateExecute).toHaveBeenCalledTimes(1);
    const [id, payload, user] = mocks.updateExecute.mock.calls[0];
    expect(id).toBe('appt-1');
    expect(payload).toMatchObject({
      date: target,
      time: '09:00', // normalizado
      doctorId: 'doc-1',
      rescheduleReason: 'Paciente pediu',
    });
    expect(payload.rescheduledAt).toBeInstanceOf(Date);
    // Remarcar NUNCA envia status/financeiro — só mexe em quando acontece
    expect(Object.keys(payload).sort()).toEqual(['date', 'doctorId', 'rescheduleReason', 'rescheduledAt', 'time']);
    expect(user).toBe(admin);
    expect(result.message).toMatch(/remarcado/i);
    expect(result.data).toEqual({ _id: 'appt-1' });
  });

  it('usa motivo padrão quando não informado', async () => {
    mocks.appointmentFindById.mockReturnValue(query(baseAppointment()));
    await execute('appt-1', { date: future(6), time: '10:00' }, admin);
    expect(mocks.updateExecute.mock.calls[0][1].rescheduleReason).toBe('Remarcação via calendário');
  });

  it('pacote remarca normalmente (consumo só no complete — nada de sessionsDone aqui)', async () => {
    mocks.appointmentFindById.mockReturnValue(
      query(baseAppointment({ serviceType: 'package_session', package: 'pkg-1' }))
    );
    await execute('appt-1', { date: future(6), time: '10:00' }, admin);
    expect(mocks.updateExecute).toHaveBeenCalledTimes(1);
    expect(mocks.guideFindById).not.toHaveBeenCalled();
    expect(mocks.liminarFindById).not.toHaveBeenCalled();
  });

  it('convênio: guia vencendo antes da nova data → 409 e não grava nada', async () => {
    mocks.appointmentFindById.mockReturnValue(
      query(baseAppointment({ billingType: 'convenio', insuranceGuide: 'guide-1' }))
    );
    mocks.guideFindById.mockReturnValue(
      query({ number: '16323329', status: 'active', expiresAt: new Date(`${future(4)}T12:00:00.000Z`) })
    );

    await expect(execute('appt-1', { date: future(10), time: '10:00' }, admin)).rejects.toMatchObject({
      code: 'GUIDE_EXPIRES_BEFORE_DATE',
      status: 409,
    });
    expect(mocks.updateExecute).not.toHaveBeenCalled();
  });

  it('convênio: guia válida na nova data → grava', async () => {
    mocks.appointmentFindById.mockReturnValue(
      query(baseAppointment({ billingType: 'convenio', insuranceGuide: 'guide-1' }))
    );
    mocks.guideFindById.mockReturnValue(
      query({ number: '16323329', status: 'active', expiresAt: new Date(`${future(30)}T12:00:00.000Z`) })
    );

    await execute('appt-1', { date: future(10), time: '10:00' }, admin);
    expect(mocks.updateExecute).toHaveBeenCalledTimes(1);
  });

  it('liminar: vigência acabando antes da nova data → 409', async () => {
    mocks.appointmentFindById.mockReturnValue(
      query(baseAppointment({ billingType: 'liminar', liminarContract: 'lim-1' }))
    );
    mocks.liminarFindById.mockReturnValue(
      query({ expirationDate: new Date(`${future(4)}T12:00:00.000Z`) })
    );

    await expect(execute('appt-1', { date: future(10), time: '10:00' }, admin)).rejects.toMatchObject({
      code: 'LIMINAR_EXPIRES_BEFORE_DATE',
      status: 409,
    });
    expect(mocks.updateExecute).not.toHaveBeenCalled();
  });

  it.each(['canceled', 'cancelado'])('%s: reativa (status scheduled + limpa cancelamento) e remarca', async (operationalStatus) => {
    mocks.appointmentFindById.mockReturnValue(query(baseAppointment({ operationalStatus })));

    const result = await execute('appt-1', { date: future(6), time: '10:00' }, admin);

    const payload = mocks.updateExecute.mock.calls[0][1];
    expect(payload).toMatchObject({
      operationalStatus: 'scheduled',
      canceledAt: null,
      cancelReason: '',
      date: future(6),
      time: '10:00',
    });
    expect(payload.rescheduleReason).toMatch(/Reativado/);
    expect(result.reactivated).toBe(true);
    expect(result.message).toMatch(/reativado/i);
  });

  it('remarcação normal NÃO envia operationalStatus (não mexe no status)', async () => {
    mocks.appointmentFindById.mockReturnValue(query(baseAppointment({ operationalStatus: 'confirmed' })));
    const result = await execute('appt-1', { date: future(6), time: '10:00' }, admin);
    expect(mocks.updateExecute.mock.calls[0][1]).not.toHaveProperty('operationalStatus');
    expect(result.reactivated).toBe(false);
  });

  it.each(['completed', 'missed'])('%s é histórico: 422 e não grava', async (operationalStatus) => {
    mocks.appointmentFindById.mockReturnValue(query(baseAppointment({ operationalStatus })));
    await expect(execute('appt-1', { date: future(10), time: '10:00' }, admin)).rejects.toMatchObject({
      code: 'INVALID_STATUS_FOR_RESCHEDULE',
      status: 422,
    });
    expect(mocks.updateExecute).not.toHaveBeenCalled();
  });

  it('profissional só remarca os próprios agendamentos (403)', async () => {
    mocks.appointmentFindById.mockReturnValue(query(baseAppointment({ doctor: 'doc-1' })));
    const otherDoctor = { _id: 'doc-2', role: 'doctor' };

    await expect(execute('appt-1', { date: future(6), time: '10:00' }, otherDoctor)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(mocks.updateExecute).not.toHaveBeenCalled();
  });

  it('propaga o erro do updateAppointmentCommand (ex.: slot ocupado por corrida)', async () => {
    mocks.appointmentFindById.mockReturnValue(query(baseAppointment()));
    mocks.updateExecute.mockRejectedValue(
      Object.assign(new Error('Já existe um agendamento'), { status: 409, code: 'APPOINTMENT_SLOT_TAKEN' })
    );

    await expect(execute('appt-1', { date: future(6), time: '10:00' }, admin)).rejects.toMatchObject({
      code: 'APPOINTMENT_SLOT_TAKEN',
      status: 409,
    });
  });
});
