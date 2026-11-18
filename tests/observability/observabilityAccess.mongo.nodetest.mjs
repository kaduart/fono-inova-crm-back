// Acesso às rotas de observabilidade, diagnóstico e filas: público mínimo,
// staff (admin/secretary) para leitura e admin para o que lê dados de paciente,
// injeta eventos, limpa Redis ou mexe em filas. Mongo e Redis de loopback.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
//     node --test --test-force-exit tests/observability/observabilityAccess.mongo.nodetest.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TEST_URI;
const loop = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);
const skip = !URI || !process.env.REDIS_URL ? 'MONGO_TEST_URI e REDIS_URL (loopback) necessários' : false;
if (URI && !loop(URI)) throw new Error('MONGO_TEST_URI precisa ser loopback');
if (process.env.REDIS_URL && !loop(process.env.REDIS_URL)) throw new Error('REDIS_URL precisa ser loopback');
process.env.JWT_SECRET = 'segredo-de-teste-ficticio';

let app;
const tok = {};
const sign = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '5m' });

// [método, caminho, nível] — nível: public | staff | admin
const ROUTES = [
  ['GET', '/api/health', 'public'],
  ['GET', '/api/v2/health', 'public'],
  ['GET', '/api/health/basic', 'staff'],
  ['GET', '/api/health/monitor', 'staff'],
  ['GET', '/api/health/detailed', 'staff'],
  ['GET', '/api/health/stuck-events', 'staff'],
  ['GET', '/api/health/queues', 'staff'],
  ['GET', '/api/health/full', 'staff'],
  ['GET', '/api/health/workers', 'staff'],
  ['GET', '/api/health/whatsapp', 'staff'],
  ['GET', '/api/v2/health/detalhes', 'staff'],
  ['GET', '/api/metrics/dashboard', 'staff'],
  ['GET', '/api/metrics/slo', 'staff'],
  ['GET', '/api/metrics/decision', 'staff'],
  ['GET', '/api/metrics/packages', 'staff'],
  ['GET', '/api/metrics/packages/realtime', 'staff'],
  ['POST', '/api/metrics/packages/record', 'admin'],
  ['GET', '/api/observability/health', 'staff'],
  ['GET', '/api/observability/whatsapp-health', 'staff'],
  ['GET', '/api/observability/metrics', 'staff'],
  ['GET', '/api/observability/recent', 'staff'],
  ['GET', '/api/observability/alerts', 'staff'],
  ['GET', '/api/observability/domains', 'staff'],
  ['GET', '/api/observability/system-health', 'staff'],
  ['GET', '/api/diagnostic/chat-status', 'admin'],
  ['GET', '/api/diagnostic/last-webhooks', 'admin'],
  ['POST', '/api/diagnostic/test-message', 'admin'],
  ['POST', '/api/diagnostic/test-full-flow', 'admin'],
  ['POST', '/api/diagnostic/clear-debounce', 'admin'],
  ['GET', '/admin/queues', 'admin'],
];
const call = (m, p, t) => {
  const r = request(app)[m.toLowerCase()](p);
  if (t) r.set('Authorization', `Bearer ${t}`);
  return r.timeout({ response: 10000 });
};

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_obs_access_${Date.now()}` });
  const { default: Admin } = await import('../../models/Admin.js');
  const { default: Doctor } = await import('../../models/Doctor.js');
  const ids = { admin: new mongoose.Types.ObjectId(), secretary: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId() };
  await Admin.collection.insertMany([
    { _id: ids.admin, name: 'Admin Ficticio', email: 'a@teste.invalid', role: 'admin' },
    { _id: ids.secretary, name: 'Sec Ficticia', email: 's@teste.invalid', role: 'secretary' }
  ]);
  await Doctor.collection.insertOne({ _id: ids.doctor, fullName: 'Dra Ficticia', email: 'd@teste.invalid', role: 'doctor' });
  for (const r of Object.keys(ids)) tok[r] = sign(String(ids[r]), r);

  const { bullBoardGuard } = await import('../../middleware/observabilityAccess.js');
  const mounts = [
    ['/api/health', '../../routes/health.js'],
    ['/api/v2/health', '../../routes/health.v2.js'],
    ['/api/diagnostic', '../../routes/whatsapp/diagnostic.js'],
    ['/api/metrics', '../../routes/metrics.dashboard.js'],
    ['/api/metrics/packages', '../../routes/package.metrics.js'],
    ['/api/observability', '../../infrastructure/observability/observabilityRoutes.js'],
  ];
  app = express();
  app.use(express.json());
  for (const [base, file] of mounts) app.use(base, (await import(file)).default);
  const { serverAdapter } = await import('../../routes/adminSystem.js');
  app.use('/admin/queues', bullBoardGuard, serverAdapter.getRouter());
});
after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('público mínimo: só status e timestamp, sem filas, memória ou erros', { skip }, async () => {
  for (const [m, p] of ROUTES.filter((r) => r[2] === 'public')) {
    const r = await call(m, p);
    assert.ok([200, 503].includes(r.status), `${p} ${r.status}`);
    assert.deepEqual(Object.keys(r.body).sort(), ['status', 'timestamp'], p);
  }
});

test('sem token: tudo que não é público responde 401', { skip }, async () => {
  for (const [m, p] of ROUTES.filter((r) => r[2] !== 'public')) {
    const r = await call(m, p);
    assert.equal(r.status, 401, `${m} ${p} → ${r.status}`);
  }
});

test('doutora (perfil sem acesso): 403 em staff e admin', { skip }, async () => {
  for (const [m, p] of ROUTES.filter((r) => r[2] !== 'public')) {
    const r = await call(m, p, tok.doctor);
    assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
  }
});

test('secretaria: lê os painéis (staff) e recebe 403 no que é só admin', { skip }, async () => {
  for (const [m, p, lvl] of ROUTES.filter((r) => r[2] !== 'public')) {
    const r = await call(m, p, tok.secretary);
    if (lvl === 'admin') assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    else assert.ok(![401, 403].includes(r.status), `${m} ${p} → ${r.status}`);
  }
});

test('admin: passa pela guarda em todas as rotas', { skip }, async () => {
  for (const [m, p] of ROUTES.filter((r) => r[2] !== 'public' && !r[1].startsWith('/admin/queues'))) {
    if (p === '/api/diagnostic/test-full-flow' || p === '/api/diagnostic/clear-debounce') continue; // efeitos: só a guarda importa
    const r = await call(m, p, tok.admin);
    assert.ok(![401, 403].includes(r.status), `${m} ${p} → ${r.status}`);
  }
});

test('Bull Board: ?token de admin vira cookie restrito e redireciona sem o token na URL', { skip }, async () => {
  const first = await request(app).get(`/admin/queues?token=${tok.admin}`);
  assert.equal(first.status, 302);
  assert.equal(first.headers.location, '/admin/queues');
  const cookie = first.headers['set-cookie']?.[0] || '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Path=\/admin\/queues/);
  assert.match(cookie, /SameSite=Strict/i);
  const page = await request(app).get('/admin/queues').set('Cookie', cookie.split(';')[0]);
  assert.equal(page.status, 200);
  const sec = await request(app).get(`/admin/queues?token=${tok.secretary}`);
  assert.equal(sec.status, 403);
  assert.equal(sec.headers['set-cookie'], undefined);
});
