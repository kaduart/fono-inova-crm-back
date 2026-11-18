// Rota de dead letters: autenticação, papel e resposta mínima.
// Roda só com MONGO_TEST_URI (loopback, banco descartável). Dados fictícios.
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//     node --test --test-force-exit tests/observability/deadLettersAuth.mongo.nodetest.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(URI).hostname)) throw new Error('MONGO_TEST_URI precisa ser loopback');

process.env.JWT_SECRET = 'segredo-de-teste-ficticio';
const SENSITIVE = 'PACIENTE FICTICIO SENSIVEL';

let app, Admin, Doctor, EventStore;
const ids = {};
const token = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '5m' });

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_dlq_auth_${Date.now()}` });
  ({ default: Admin } = await import('../../models/Admin.js'));
  ({ default: Doctor } = await import('../../models/Doctor.js'));
  ({ default: EventStore } = await import('../../models/EventStore.js'));
  const { default: router } = await import('../../infrastructure/observability/observabilityRoutes.js');
  app = express();
  app.use(express.json());
  app.use('/api/observability', router);

  ids.admin = new mongoose.Types.ObjectId().toString();
  ids.secretary = new mongoose.Types.ObjectId().toString();
  ids.doctor = new mongoose.Types.ObjectId().toString();
  ids.inactive = new mongoose.Types.ObjectId().toString();
  await Admin.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(ids.admin), name: 'Admin Ficticio', email: 'admin@teste.invalid', role: 'admin' },
    { _id: new mongoose.Types.ObjectId(ids.secretary), name: 'Secretaria Ficticia', email: 'sec@teste.invalid', role: 'secretary' },
    { _id: new mongoose.Types.ObjectId(ids.inactive), name: 'Admin Inativo', email: 'off@teste.invalid', role: 'admin', active: false }
  ]);
  await Doctor.collection.insertOne({ _id: new mongoose.Types.ObjectId(ids.doctor), fullName: 'Doutora Ficticia', email: 'doc@teste.invalid', role: 'doctor' });
  await EventStore.collection.insertOne({
    eventId: 'dlq-ficticio-1', eventType: 'APPOINTMENT_CREATED', aggregateType: 'appointment', aggregateId: 'agg-ficticio',
    status: 'dead_letter', attempts: 5, createdAt: new Date(),
    payload: { patientName: SENSITIVE, cpf: '000.000.000-00' },
    metadata: { correlationId: 'corr-ficticio', source: 'teste', headers: { authorization: 'Bearer x' } },
    error: { message: 'falha ficticia', code: 'E_TESTE', stack: `Error: falha\n    at ${SENSITIVE}` },
    idempotencyKey: 'chave-ficticia'
  });
});
after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

for (const path of ['/api/observability/dead-letters', '/api/observability/dead-letters/dlq-ficticio-1']) {
  test(`${path}: sem token → 401`, { skip }, async () => {
    const r = await request(app).get(path);
    assert.equal(r.status, 401);
    assert.ok(!JSON.stringify(r.body).includes(SENSITIVE));
  });
  test(`${path}: token inválido → 401`, { skip }, async () => {
    const r = await request(app).get(path).set('Authorization', 'Bearer invalido');
    assert.equal(r.status, 401);
  });
  test(`${path}: secretária e profissional → 403`, { skip }, async () => {
    for (const [id, role] of [[ids.secretary, 'secretary'], [ids.doctor, 'doctor']]) {
      const r = await request(app).get(path).set('Authorization', `Bearer ${token(id, role)}`);
      assert.equal(r.status, 403, role);
      assert.ok(!JSON.stringify(r.body).includes(SENSITIVE));
    }
  });
  test(`${path}: admin desativado → 401`, { skip }, async () => {
    const r = await request(app).get(path).set('Authorization', `Bearer ${token(ids.inactive, 'admin')}`);
    assert.equal(r.status, 401);
  });
}

test('admin lista: 200 e resposta mínima', { skip }, async () => {
  const r = await request(app).get('/api/observability/dead-letters?limit=100000&sort=payload.cpf').set('Authorization', `Bearer ${token(ids.admin, 'admin')}`);
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.body);
  assert.ok(!body.includes(SENSITIVE), 'sem payload nem stack');
  assert.ok(!body.includes('authorization'));
  assert.equal(r.body.data[0].eventId, 'dlq-ficticio-1');
  assert.deepEqual(r.body.data[0].error, { message: 'falha ficticia', code: 'E_TESTE' });
  assert.equal(r.body.pagination.limit, 100, 'limite máximo aplicado');
});

test('admin detalhe: 200, só nomes dos campos do payload', { skip }, async () => {
  const r = await request(app).get('/api/observability/dead-letters/dlq-ficticio-1').set('Authorization', `Bearer ${token(ids.admin, 'admin')}`);
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.eventId, 'dlq-ficticio-1');
  assert.deepEqual(d.payloadKeys, ['cpf', 'patientName']);
  assert.equal(d.payload, undefined);
  assert.equal(d.metadata, undefined);
  assert.equal(d.idempotencyKey, undefined);
  assert.equal(d.hasIdempotencyKey, true);
  assert.ok(!JSON.stringify(r.body).includes(SENSITIVE));
  assert.ok(!JSON.stringify(r.body).includes('000.000.000-00'));
});

test('admin detalhe inexistente: 404 sem ecoar o parâmetro', { skip }, async () => {
  const r = await request(app).get('/api/observability/dead-letters/nao-existe-xyz').set('Authorization', `Bearer ${token(ids.admin, 'admin')}`);
  assert.equal(r.status, 404);
  assert.ok(!JSON.stringify(r.body).includes('nao-existe-xyz'));
});

test('retry continua exigindo admin', { skip }, async () => {
  const r = await request(app).post('/api/observability/dead-letters/dlq-ficticio-1/retry').set('Authorization', `Bearer ${token(ids.secretary, 'secretary')}`);
  assert.equal(r.status, 403);
});
