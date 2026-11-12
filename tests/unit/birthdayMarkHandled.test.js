import { describe, it, expect, vi, beforeEach } from 'vitest';
import moment from 'moment-timezone';

const findById = vi.fn();
const updateOne = vi.fn();
vi.mock('../../models/Patient.js', () => ({ default: { findById: (...a) => findById(...a), updateOne: (...a) => updateOne(...a) } }));
vi.mock('../../config/bullConfig.js', () => ({ whatsappSendQueue: { add: vi.fn() } }));

const { daysSinceBirthday, markBirthdayHandled } = await import('../../services/birthday/birthdayMessageService.js');

const now = moment.tz('2026-11-12 17:00', 'America/Sao_Paulo');
const patient = (dob, year = null) => findById.mockReturnValue({ select: () => ({ lean: async () => ({ dateOfBirth: dob, birthdayMessageSentYear: year }) }) });

describe('daysSinceBirthday', () => {
  it('conta pelo dia UTC do nascimento no fuso da clínica', () => {
    expect(daysSinceBirthday('2019-11-12T00:00:00Z', now)).toBe(0);
    expect(daysSinceBirthday('2019-11-05T00:00:00Z', now)).toBe(7);
    expect(daysSinceBirthday('2019-11-20T00:00:00Z', now)).toBe(-8);
  });
  it('29/02 em ano não bissexto vira 28/02', () => {
    expect(daysSinceBirthday('2020-02-29T00:00:00Z', moment.tz('2027-03-01 10:00', 'America/Sao_Paulo'))).toBe(1);
  });
});

describe('markBirthdayHandled', () => {
  beforeEach(() => { findById.mockReset(); updateOne.mockReset(); });

  it('marca como manual quem fez aniversário nos últimos 7 dias', async () => {
    patient('2019-11-08T00:00:00Z');
    updateOne.mockResolvedValue({ modifiedCount: 1 });
    expect(await markBirthdayHandled('p1', { now })).toEqual({ marked: true });
    expect(updateOne.mock.calls[0][1].$set).toMatchObject({ birthdayMessageSentYear: 2026, birthdayMessageSentVia: 'manual' });
  });

  it('não marca fora da janela (vale todo ano, sem data fixa)', async () => {
    patient('2019-10-01T00:00:00Z');
    expect(await markBirthdayHandled('p1', { now })).toEqual({ marked: false, reason: 'out_of_window' });
    patient('2019-12-01T00:00:00Z');
    expect(await markBirthdayHandled('p1', { now })).toEqual({ marked: false, reason: 'out_of_window' });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('já enviado no ano é idempotente', async () => {
    patient('2019-11-08T00:00:00Z', 2026);
    expect(await markBirthdayHandled('p1', { now })).toEqual({ marked: false, reason: 'already_sent' });
  });

  it('ano seguinte libera de novo', async () => {
    patient('2019-11-08T00:00:00Z', 2026);
    updateOne.mockResolvedValue({ modifiedCount: 1 });
    expect(await markBirthdayHandled('p1', { now: moment.tz('2027-11-10 09:00', 'America/Sao_Paulo') })).toEqual({ marked: true });
  });
});
