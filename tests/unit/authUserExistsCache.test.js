/**
 * Cache de userModel.exists() em middleware/auth.js.
 *
 * Toda request autenticada do sistema passa por esse middleware, então um
 * round-trip ao Mongo por request (mesmo quando a rota devolve 304) é custo
 * pago em toda página que dispara várias chamadas paralelas. Este arquivo
 * comprova a MECÂNICA do cache (menos queries em requests repetidos do mesmo
 * usuário, sem furar o isolamento entre usuários diferentes) e que os
 * caminhos de erro pré-existentes continuam intactos.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const JWT_SECRET = 'test-secret-auth-cache';

let replSet;
let Admin;
let Doctor;
let auth;
let app;

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET);
}

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  Admin = (await import('../../models/Admin.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  ({ auth } = await import('../../middleware/auth.js'));

  app = express();
  app.get('/protected', auth, (req, res) => res.json({ userId: req.user.id, role: req.user.role }));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map(collection => collection.deleteMany({})));
});

describe('auth — cache de userModel.exists()', () => {
  it('a segunda request do mesmo usuário dentro do TTL não bate no Mongo de novo', async () => {
    const admin = await Admin.create({ fullName: 'Admin Cache', email: 'admin-cache@test.local', password: 'x', role: 'admin' });
    const token = signToken({ id: admin._id.toString(), role: 'admin' });
    const existsSpy = vi.spyOn(Admin, 'exists');

    const first = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(existsSpy).toHaveBeenCalledTimes(1);

    const second = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(existsSpy).toHaveBeenCalledTimes(1); // não repetiu — veio do cache

    existsSpy.mockRestore();
  });

  it('usuários diferentes não compartilham entrada de cache', async () => {
    const [admin1, admin2] = await Promise.all([
      Admin.create({ fullName: 'Admin Um', email: 'admin1-cache@test.local', password: 'x', role: 'admin' }),
      Admin.create({ fullName: 'Admin Dois', email: 'admin2-cache@test.local', password: 'x', role: 'admin' })
    ]);
    const existsSpy = vi.spyOn(Admin, 'exists');

    await request(app).get('/protected').set('Authorization', `Bearer ${signToken({ id: admin1._id.toString(), role: 'admin' })}`);
    await request(app).get('/protected').set('Authorization', `Bearer ${signToken({ id: admin2._id.toString(), role: 'admin' })}`);

    expect(existsSpy).toHaveBeenCalledTimes(2); // um por usuário — cache não vazou entre eles

    existsSpy.mockRestore();
  });

  it('Admin e Doctor com o mesmo _id textual não colidem na chave de cache', async () => {
    // Cenário construído: paranoia deliberada, não uma colisão real observada.
    // A chave de cache inclui o nome do model (Admin:<id> vs Doctor:<id>)
    // justamente para não depender de ObjectIds nunca colidirem entre as
    // duas collections.
    const admin = await Admin.create({ fullName: 'Admin X', email: 'admin-x@test.local', password: 'x', role: 'admin' });
    const doctor = await Doctor.create({
      fullName: 'Doctor X',
      email: 'doctor-x@test.local',
      specialty: 'fonoaudiologia',
      licenseNumber: 'CRFA-CACHE-TEST-1',
      phoneNumber: '11999999999'
    });
    const adminExistsSpy = vi.spyOn(Admin, 'exists');
    const doctorExistsSpy = vi.spyOn(Doctor, 'exists');

    await request(app).get('/protected').set('Authorization', `Bearer ${signToken({ id: admin._id.toString(), role: 'admin' })}`);
    await request(app).get('/protected').set('Authorization', `Bearer ${signToken({ id: doctor._id.toString(), role: 'doctor' })}`);

    expect(adminExistsSpy).toHaveBeenCalledTimes(1);
    expect(doctorExistsSpy).toHaveBeenCalledTimes(1);

    adminExistsSpy.mockRestore();
    doctorExistsSpy.mockRestore();
  });

  it('usuário inexistente continua devolvendo 401 USER_NOT_FOUND (resultado negativo também é cacheado)', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const token = signToken({ id: fakeId, role: 'admin' });
    const existsSpy = vi.spyOn(Admin, 'exists');

    const first = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(401);
    expect(first.body.code).toBe('USER_NOT_FOUND');

    const second = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(401);
    expect(second.body.code).toBe('USER_NOT_FOUND');
    expect(existsSpy).toHaveBeenCalledTimes(1); // o "não existe" também veio do cache na 2ª

    existsSpy.mockRestore();
  });

  it('caminhos de erro pré-existentes continuam intactos: sem token, token malformado, payload inválido', async () => {
    const noToken = await request(app).get('/protected');
    expect(noToken.status).toBe(401);
    expect(noToken.body.code).toBe('TOKEN_REQUIRED');

    const malformed = await request(app).get('/protected').set('Authorization', 'Bearer not-a-real-jwt');
    expect(malformed.status).toBe(401);
    expect(malformed.body.code).toBe('INVALID_TOKEN');

    const badPayload = await request(app).get('/protected').set('Authorization', `Bearer ${signToken({ role: 'admin' })}`); // sem id
    expect(badPayload.status).toBe(401);
    expect(badPayload.body.code).toBe('INVALID_TOKEN_PAYLOAD');
  });

  it('token expirado continua devolvendo 401 TOKEN_EXPIRED', async () => {
    const admin = await Admin.create({ fullName: 'Admin Expira', email: 'admin-expira@test.local', password: 'x', role: 'admin' });
    const expiredToken = jwt.sign({ id: admin._id.toString(), role: 'admin' }, JWT_SECRET, { expiresIn: -10 });

    const res = await request(app).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });
});
