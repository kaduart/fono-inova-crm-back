/**
 * Aviso de cancelamento por WhatsApp — SEM mensagens reais (fila 100% mockada).
 * Cobre: marcado/desmarcado, só depois de salvar, falha sem desfazer cancelamento,
 * reenvio sem cancelar de novo, duplicidade, sem telefone e texto sem cancelReason.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setLegacyGraceUntilForTests } from '../../domain/appointment/cancelRequester.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_cancel_notify';

const fakeQueue = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('../../config/bullConfig.js', () => new Proxy({}, {
  get: (_t, k) => (k === '__esModule' ? true : k === 'then' ? undefined : fakeQueue),
  has: () => true,
}));
vi.mock('../../config/socket.js', () => ({ getIo: vi.fn().mockReturnValue({ emit: vi.fn() }), initializeSocket: vi.fn() }));

let Appointment, Doctor, Patient, app, notifySvc;
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await import('../../models/PatientsView.js');
  await import('../../models/User.js');
  Appointment = (await import('../../models/Appointment.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Patient = (await import('../../models/Patient.js')).default;
  notifySvc = await import('../../services/appointment/cancellationNotification.service.js');
  const router = (await import('../../routes/appointment.v2.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/v2/appointments', router);
});
afterAll(async () => { await mongoose.disconnect(); await mongoServer.stop(); });

beforeEach(async () => {
  setLegacyGraceUntilForTests(new Date(0));
  fakeQueue.add.mockReset().mockResolvedValue({ id: 'job' });
  await Appointment.deleteMany({}); await Doctor.deleteMany({}); await Patient.deleteMany({});
});

const token = () => jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: 'admin' }, process.env.JWT_SECRET);
async function make(patientOver = {}) {
  const doctor = await Doctor.create({ fullName: 'Dra. Ana', email: `d${Math.random()}@t.com`, phoneNumber: '62999999999', licenseNumber: `C-${Math.random()}`, specialty: 'fonoaudiologia', active: true });
  const patient = await Patient.create({ fullName: 'Maria Souza', phone: '11999998888', dateOfBirth: '1990-05-15', ...patientOver });
  return Appointment.create({ patient: patient._id, doctor: doctor._id, date: '2026-10-20', time: '10:00', specialty: 'fonoaudiologia', operationalStatus: 'scheduled', duration: 40 });
}
const cancel = (id, body) => request(app).patch(`/api/v2/appointments/${id}/cancel`).set('Authorization', `Bearer ${token()}`).send({ reason: 'Anotação interna: família sem dinheiro', cancelRequester: 'patient', ...body });

describe('aviso de cancelamento por WhatsApp', () => {
  it('desmarcado (ou ausente): cancela e NÃO enfileira nada', async () => {
    const a = await make();
    const r1 = await cancel(a._id, { notifyPatient: false });
    expect(r1.status).toBe(200);
    expect(r1.body.notification.status).toBe('not_requested');
    const b = await make();
    const r2 = await cancel(b._id, {}); // cliente antigo/serviço: sem o campo
    expect(r2.body.notification.status).toBe('not_requested');
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('marcado: enfileira UMA vez, depois de salvo, sem o motivo interno no texto', async () => {
    const a = await make();
    const res = await cancel(a._id, { notifyPatient: true });
    expect(res.status).toBe(200);
    expect(res.body.notification.status).toBe('queued');
    expect(fakeQueue.add).toHaveBeenCalledTimes(1);

    const [name, data, opts] = fakeQueue.add.mock.calls[0];
    expect(name).toBe('send-message');
    expect(data.phone).toContain('11999998888');
    expect(data.message).toMatch(/Maria/);
    expect(data.message).toMatch(/20\/10\/2026 às 10:00/);
    expect(data.message).not.toMatch(/Anotação interna|dinheiro/i);
    expect(opts.jobId).toMatch(/^cancel-notify-/);

    const saved = await Appointment.findById(a._id).lean();
    expect(saved.operationalStatus).toBe('canceled');
    expect(saved.cancellationNotification.status).toBe('queued');
  });

  it('duplicidade: repetir a solicitação não enfileira de novo (inclusive simultânea)', async () => {
    const a = await make();
    await cancel(a._id, { notifyPatient: true });
    const again = await request(app).post(`/api/v2/appointments/${a._id}/cancel/notify-patient`).set('Authorization', `Bearer ${token()}`);
    expect(again.body.notification.status).toBe('already_queued');

    const b = await make();
    await Appointment.updateOne({ _id: b._id }, { $set: { operationalStatus: 'canceled', canceledAt: new Date() } });
    const [x, y] = await Promise.all([notifySvc.requestCancellationNotification(b._id), notifySvc.requestCancellationNotification(b._id)]);
    expect([x.status, y.status].sort()).toEqual(['already_queued', 'queued']);
    expect(fakeQueue.add).toHaveBeenCalledTimes(2); // 1 (a) + 1 (b)
  });

  it('falha ao enfileirar: cancelamento preservado, resultado real informado, reenvio sem cancelar de novo', async () => {
    fakeQueue.add.mockRejectedValueOnce(new Error('redis fora do ar'));
    const a = await make();
    const res = await cancel(a._id, { notifyPatient: true });
    expect(res.status).toBe(200);
    expect(res.body.notification).toMatchObject({ status: 'failed', error: 'redis fora do ar' });
    let saved = await Appointment.findById(a._id).lean();
    expect(saved.operationalStatus).toBe('canceled');
    expect(saved.cancellationNotification.status).toBe('failed');

    const retry = await request(app).post(`/api/v2/appointments/${a._id}/cancel/notify-patient`).set('Authorization', `Bearer ${token()}`);
    expect(retry.body.notification.status).toBe('queued');
    saved = await Appointment.findById(a._id).lean();
    expect(saved.cancellationNotification.attempts).toBe(2);
  });

  it('sem telefone válido: cancela, não envia e informa no_phone', async () => {
    const a = await make({ phone: '' });
    const res = await cancel(a._id, { notifyPatient: true });
    expect(res.status).toBe(200);
    expect(res.body.notification.status).toBe('no_phone');
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('cancelamento recusado (sem solicitante) não envia nada', async () => {
    const a = await make();
    const res = await request(app).patch(`/api/v2/appointments/${a._id}/cancel`).set('Authorization', `Bearer ${token()}`).send({ reason: 'x', notifyPatient: true });
    expect(res.status).toBe(400);
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('não notifica agendamento que não está cancelado', async () => {
    const a = await make();
    expect((await notifySvc.requestCancellationNotification(a._id)).status).toBe('not_canceled');
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });
});
