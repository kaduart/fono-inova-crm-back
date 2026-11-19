// Item 4 (envios), o que faltava: política para envio manual sem chave, alerta ao
// admin e rota do VPS pelo guarda, e a decisão humana sobre envios incertos.
// Provedores SIMULADOS (mock dos módulos). Mongo descartável em loopback. Dados fictícios.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' \
//     node --experimental-test-module-mocks --test --test-force-exit \
//     tests/delivery/item4Closures.mongo.nodetest.mjs
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(URI).hostname)) {
  throw new Error('MONGO_TEST_URI precisa ser loopback');
}
process.env.JWT_SECRET = 'segredo-de-teste-ficticio';
process.env.AGENDA_EXPORT_TOKEN = 'token-agenda-ficticio-teste';
process.env.REDIS_URL ??= process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6379';
delete process.env.WHATSAPP_WEB_AUTH_MODE;
delete process.env.MANUAL_SEND_REQUIRE_KEY_VPS;

const PHONE = '5562900000000'; // fictício
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── provedores simulados ──
const sim = { vps: 0, alert: 0, behaviour: null };
const resetSim = () => { sim.vps = 0; sim.alert = 0; sim.behaviour = null; };
mock.module('../../services/whatsappVPSService.js', {
  namedExports: {
    sendViaVPS: async () => { sim.vps++; if (sim.behaviour) return sim.behaviour(); return { messageId: `vps.SIM.${sim.vps}` }; },
    checkVPSStatus: async () => ({ connected: false })
  }
});
mock.module('../../config/socket.js', { namedExports: { getIo: () => null } });

const { manualKeyPolicy, manualIdempotencyKey } = await import('../../services/communication/manualSendOnce.js');
const { DELIVERY_COLLECTION, listUncertainDeliveries, deliveryKind } = await import('../../infrastructure/delivery/deliveryGuard.js');
const { adminAlertDeliveryKey, sendAdminAlertOnce } = await import('../../middleware/whatsappGuard.js');
const { default: vpsRouter } = await import('../../routes/whatsappVPS.js');

const coll = () => mongoose.connection.db.collection(DELIVERY_COLLECTION);
const fakeReq = (key) => ({ headers: key ? { 'idempotency-key': key } : {}, user: { _id: 'atendente-1' }, get(n) { return this.headers[n.toLowerCase()]; } });
const spyLog = () => { const l = { lines: [], warn: (m) => l.lines.push(m) }; return l; };

let app;
const ids = {};
const token = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '5m' });

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_envios_item4_${Date.now()}` });
  const { default: Admin } = await import('../../models/Admin.js');
  const { default: router } = await import('../../infrastructure/observability/observabilityRoutes.js');
  app = express();
  app.use(express.json());
  app.use('/api/observability', router);
  app.use('/api/whatsapp-vps', vpsRouter);
  ids.admin = new mongoose.Types.ObjectId().toString();
  ids.secretary = new mongoose.Types.ObjectId().toString();
  await Admin.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(ids.admin), name: 'Admin Ficticio', email: 'admin@teste.invalid', role: 'admin' },
    { _id: new mongoose.Types.ObjectId(ids.secretary), name: 'Secretaria Ficticia', email: 'sec@teste.invalid', role: 'secretary' }
  ]);
});
after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => { resetSim(); if (!skip) await coll().deleteMany({}); });

// ── (a) política sem chave ──
test('política: padrão log; valores aceitos off/log/on; desconhecido vira log', () => {
  assert.equal(manualKeyPolicy({}), 'log');
  assert.equal(manualKeyPolicy({ MANUAL_SEND_REQUIRE_KEY: 'ON' }), 'on');
  assert.equal(manualKeyPolicy({ MANUAL_SEND_REQUIRE_KEY: 'off' }), 'off');
  assert.equal(manualKeyPolicy({ MANUAL_SEND_REQUIRE_KEY: 'talvez' }), 'log');
});

test('política: sem chave → off silencioso, log registra, on recusa com 428', () => {
  const off = spyLog(); assert.deepEqual(manualIdempotencyKey(fakeReq(), { policy: 'off', log: off }), { key: null }); assert.equal(off.lines.length, 0);
  const lg = spyLog(); assert.deepEqual(manualIdempotencyKey(fakeReq(), { policy: 'log', log: lg, route: 'sendText' }), { key: null });
  assert.match(lg.lines[0], /manual_send_without_key/); assert.match(lg.lines[0], /sendText/);
  const on = spyLog(); const r = manualIdempotencyKey(fakeReq(), { policy: 'on', log: on });
  assert.equal(r.status, 428); assert.equal(r.code, 'IDEMPOTENCY_KEY_REQUIRED'); assert.equal(r.key, undefined);
  const ok = manualIdempotencyKey(fakeReq('chave-valida-01'), { policy: 'on' }); assert.equal(ok.key, 'chave-valida-01');
  const bad = manualIdempotencyKey(fakeReq('x'), { policy: 'on' }); assert.equal(bad.status, 400);
});

// ── (c) alerta ao admin ──
test('alerta ao admin: 3 disparos simultâneos do mesmo tipo = 1 envio; nova janela envia de novo', { skip }, async () => {
  const send = async () => { sim.alert++; await sleep(100); return { messages: [{ id: `wamid.SIM.alert.${sim.alert}` }] }; };
  const now = 1_800_000_000_000;
  const rs = await Promise.all([1, 2, 3].map(() => sendAdminAlertOnce({ type: 'silence', text: 'teste', to: PHONE, now, send })));
  assert.equal(sim.alert, 1);
  assert.equal(rs.filter(Boolean).length, 1);
  assert.equal(await sendAdminAlertOnce({ type: 'anomaly', text: 'teste', to: PHONE, now, send }), true);
  assert.equal(await sendAdminAlertOnce({ type: 'silence', text: 'teste', to: PHONE, now: now + 31 * 60_000, send }), true);
  assert.equal(sim.alert, 3);
  assert.notEqual(adminAlertDeliveryKey('silence', now), adminAlertDeliveryKey('silence', now + 31 * 60_000));
});

// ── (c) rota do VPS ──
const vps = (key, body = { phone: PHONE, message: 'mensagem ficticia' }) => {
  const r = request(app).post('/api/whatsapp-vps/send').set('Authorization', `Bearer ${process.env.AGENDA_EXPORT_TOKEN}`).send(body);
  return key ? r.set('Idempotency-Key', key) : r;
};

test('VPS: mesma chave duas vezes = 1 envio; 2ª resposta duplicada', { skip }, async () => {
  const a = await vps('k-vps-00001');
  const b = await vps('k-vps-00001');
  assert.equal(a.status, 200); assert.equal(a.body.success, true);
  assert.equal(b.status, 200); assert.equal(b.body.duplicated, true);
  assert.equal(sim.vps, 1);
  const doc = await coll().findOne({});
  assert.equal(deliveryKind(doc._id), 'wa:manual:vps');
});

test('VPS: timeout do VPS vira incerto e não reenvia na repetição', { skip }, async () => {
  sim.behaviour = () => { throw new Error('fetch failed: socket hang up'); };
  const a = await vps('k-vps-timeout');
  const b = await vps('k-vps-timeout');
  assert.equal(a.status, 409); assert.equal(a.body.code, 'DELIVERY_UNCERTAIN');
  assert.equal(b.status, 409);
  assert.equal(sim.vps, 1);
});

test('VPS: sem chave envia como antes (Agenda Externa); com política on recusa 428', { skip }, async () => {
  const a = await vps(null);
  assert.equal(a.status, 200); assert.equal(sim.vps, 1);
  process.env.MANUAL_SEND_REQUIRE_KEY_VPS = 'on';
  try {
    const b = await vps(null);
    assert.equal(b.status, 428); assert.equal(sim.vps, 1);
  } finally { delete process.env.MANUAL_SEND_REQUIRE_KEY_VPS; }
});

// ── (b) envios incertos: listar e decidir ──
async function seedUncertain() {
  const now = new Date();
  await coll().insertMany([
    { _id: 'wa:manual:atendente-1:tpl:k-tpl-xyz1:abcdef012345', channel: 'whatsapp', destinationHash: 'h1', status: 'unknown', attempts: 1, createdAt: now, lastError: `timeout ao enviar para ${PHONE}`, history: [{ at: now, status: 'unknown', reason: 'provider_result_unknown' }] },
    { _id: 'alert:admin:silence:1000', channel: 'whatsapp', destinationHash: 'h2', status: 'sending', token: 't', leaseUntil: new Date(now.getTime() - 1000), attempts: 1, createdAt: now, history: [{ at: now, status: 'sending' }] },
    { _id: 'amanda-reply:lead1:wamid1', channel: 'whatsapp', destinationHash: 'h3', status: 'sent', attempts: 1, createdAt: now, history: [] },
    { _id: 'amanda-reply:lead2:wamid2', channel: 'whatsapp', destinationHash: 'h4', status: 'sending', token: 't2', leaseUntil: new Date(now.getTime() + 60_000), attempts: 1, createdAt: now, history: [] }
  ]);
}
const asAdmin = (r) => r.set('Authorization', `Bearer ${token(ids.admin, 'admin')}`);

test('incertos: sem token 401, secretária 403', { skip }, async () => {
  assert.equal((await request(app).get('/api/observability/deliveries/uncertain')).status, 401);
  const sec = await request(app).get('/api/observability/deliveries/uncertain').set('Authorization', `Bearer ${token(ids.secretary, 'secretary')}`);
  assert.equal(sec.status, 403);
  const secPost = await request(app).post('/api/observability/deliveries/resolve').set('Authorization', `Bearer ${token(ids.secretary, 'secretary')}`).send({ key: 'x:y:z', as: 'sent' });
  assert.equal(secPost.status, 403);
});

test('incertos: lista unknown + abandonado, sem telefone nem hash do destino', { skip }, async () => {
  await seedUncertain();
  const r = await asAdmin(request(app).get('/api/observability/deliveries/uncertain'));
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  const kinds = r.body.items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['alert:admin', 'wa:manual:tpl']);
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes(PHONE), 'telefone vazou');
  assert.ok(!raw.includes('destinationHash'));
  assert.equal(r.body.items.find((i) => i.kind === 'alert:admin').status, 'abandoned');
  const direct = await listUncertainDeliveries();
  assert.equal(direct.total, 2);
});

test('incertos: decidir "failed" libera nova tentativa; decidir de novo dá 409; abandonado também resolve', { skip }, async () => {
  await seedUncertain();
  const key = 'wa:manual:atendente-1:tpl:k-tpl-xyz1:abcdef012345';
  const a = await asAdmin(request(app).post('/api/observability/deliveries/resolve')).send({ key, as: 'failed', note: 'conferi no WhatsApp, não chegou' });
  assert.equal(a.status, 200);
  const doc = await coll().findOne({ _id: key });
  assert.equal(doc.status, 'failed'); assert.equal(doc.resolvedBy, ids.admin);
  assert.equal(doc.history.at(-1).reason, 'manual_resolution');
  const b = await asAdmin(request(app).post('/api/observability/deliveries/resolve')).send({ key, as: 'sent' });
  assert.equal(b.status, 409); assert.equal(b.body.code, 'DELIVERY_NOT_UNCERTAIN');
  const c = await asAdmin(request(app).post('/api/observability/deliveries/resolve')).send({ key: 'alert:admin:silence:1000', as: 'sent' });
  assert.equal(c.status, 200);
  assert.equal((await coll().findOne({ _id: 'alert:admin:silence:1000' })).status, 'sent');
  const d = await asAdmin(request(app).post('/api/observability/deliveries/resolve')).send({ key: 'amanda-reply:lead2:wamid2', as: 'sent' });
  assert.equal(d.status, 409, 'envio em andamento (lease válido) não pode ser decidido');
  const bad = await asAdmin(request(app).post('/api/observability/deliveries/resolve')).send({ key, as: 'talvez' });
  assert.equal(bad.status, 400);
});
