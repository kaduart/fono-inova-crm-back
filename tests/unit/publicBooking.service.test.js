/**
 * Agendamento público com Mongo real em memória: cria pré-agendamento, é idempotente,
 * não pega horário ocupado e respeita o limite por telefone. Doc: docs/flows/public_booking_flow.md
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
  publishEvent: vi.fn(async () => ({})),
  EventTypes: { PATIENT_CREATED: 'PATIENT_CREATED' },
}));

const { default: Appointment } = await import('../../models/Appointment.js');
const { default: Doctor } = await import('../../models/Doctor.js');
const { default: Patient } = await import('../../models/Patient.js');
const { createHold, getOptions, getStatus, PublicBookingError } = await import('../../services/publicBooking/publicBookingService.js');

const NOW = new Date('2026-11-10T21:00:00Z'); // terça 18h SP
const DATE = '2026-11-12'; // quinta

let mongod;
beforeAll(async () => {
  // TEST_MONGO_URI permite rodar contra um Mongo local (sem baixar binário)
  const uri = process.env.TEST_MONGO_URI || (mongod = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri, { dbName: 'public_booking_test' });
}, 60000);

afterAll(async () => {
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  await mongod?.stop();
});

let doctor;
beforeEach(async () => {
  await Promise.all([Appointment.deleteMany({}), Doctor.deleteMany({}), Patient.deleteMany({})]);
  doctor = await Doctor.create({
    fullName: 'Dra Teste Fono',
    email: 'fono@teste.local',
    specialty: 'fonoaudiologia',
    licenseNumber: 'CRFA-1',
    phoneNumber: '62900000000',
    active: true,
    weeklyAvailability: [{ day: 'thursday', times: ['08:00', '08:40', '14:00'] }],
  });
});

const base = {
  specialty: 'fonoaudiologia',
  date: DATE,
  period: 'manha',
  childName: 'Maria Clara Souza',
  birthDate: '2021-05-10',
  responsibleName: 'Ana Souza',
  phone: '62999990000',
  utm: { source: 'instagram', medium: 'bio' },
};

describe('publicBookingService', () => {
  it('cria pré-agendamento no primeiro horário livre da manhã', async () => {
    const r = await createHold(base, { now: NOW, env: {} });
    expect(r.display).toBe('Quinta 12/11 de manhã');
    expect(r.code).toMatch(/^FI-/);

    const appt = await Appointment.findOne({ 'metadata.origin.bookingCode': r.code }).lean();
    expect(appt.operationalStatus).toBe('pre_agendado');
    expect(appt.time).toBe('08:00');
    expect(String(appt.doctor)).toBe(String(doctor._id));
    expect(appt.metadata.origin.source).toBe('instagram');
    expect(appt.metadata.origin.channel).toBe('link_agendamento');
    expect(appt.sessionValue).toBe(0);

    const patient = await Patient.findById(appt.patient).lean();
    expect(patient.source).toBe('link_agendamento');

    expect(await getStatus(r.code)).toEqual({ status: 'reservado', display: 'Quinta 12/11 de manhã' });
  });

  it('mesmo telefone + mesma criança devolve a mesma reserva (sem duplicar)', async () => {
    const a = await createHold(base, { now: NOW, env: {} });
    const b = await createHold({ ...base, childName: 'maria clara souza' }, { now: NOW, env: {} });
    expect(b.code).toBe(a.code);
    expect(await Appointment.countDocuments({})).toBe(1);
    expect(await Patient.countDocuments({})).toBe(1);
  });

  it('segunda criança do mesmo telefone pega o próximo horário; terceira é barrada', async () => {
    const a = await createHold(base, { now: NOW, env: {} });
    const b = await createHold({ ...base, childName: 'Pedro Souza' }, { now: NOW, env: {} });
    expect(b.code).not.toBe(a.code);
    const times = (await Appointment.find({}).lean()).map((x) => x.time).sort();
    expect(times).toEqual(['08:00', '08:40']);
    await expect(createHold({ ...base, childName: 'João Souza', period: 'tarde' }, { now: NOW, env: {} }))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', status: 429 });
  });

  it('período lotado devolve 409 com alternativa', async () => {
    await createHold(base, { now: NOW, env: {} });
    await createHold({ ...base, childName: 'Pedro Souza', phone: '62988880000' }, { now: NOW, env: {} });
    const err = await createHold({ ...base, childName: 'Lia Souza', phone: '62977770000' }, { now: NOW, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(PublicBookingError);
    expect(err.code).toBe('PERIOD_FULL');
    expect(err.extra.alternatives).toEqual([{ date: DATE, period: 'tarde' }]);
  });

  it('teto diário de reservas online', async () => {
    await createHold(base, { now: NOW, env: { PUBLIC_BOOKING_DAILY_CAP: '1' } });
    await expect(createHold({ ...base, childName: 'Outra Pessoa', phone: '62988880000' }, { now: NOW, env: { PUBLIC_BOOKING_DAILY_CAP: '1' } }))
      .rejects.toMatchObject({ code: 'DAILY_CAP' });
  });

  it('options mostra só dia + período, sem profissional', async () => {
    const r = await getOptions({ specialty: 'fonoaudiologia', from: DATE, days: 1, now: NOW });
    expect(r.days).toEqual([{ date: DATE, label: 'Qui 12/11', periods: [{ period: 'manha', available: true }, { period: 'tarde', available: true }] }]);
    expect(JSON.stringify(r)).not.toContain('Dra Teste');
  });
});
