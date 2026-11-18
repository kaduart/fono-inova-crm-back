// Proteção local contra reenvio (WhatsApp/e-mail) com provedor SIMULADO.
// Nenhum envio real. Mongo descartável em loopback; dados fictícios.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//     node --test --test-force-exit tests/delivery/deliveryGuard.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  guardedSend, resolveUncertainDelivery, isDefinitelyNotSent, destinationHash,
  DeliveryOutcome, DELIVERY_COLLECTION
} from '../../infrastructure/delivery/deliveryGuard.js';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(URI).hostname)) {
  throw new Error('MONGO_TEST_URI precisa ser loopback');
}

const PHONE = '5562900000000'; // fictício
let n = 0;
const key = () => `teste:${process.pid}:${Date.now()}:${n++}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const coll = () => mongoose.connection.db.collection(DELIVERY_COLLECTION);

function fakeProvider({ delayMs = 0, failWith = null } = {}) {
  const p = {
    calls: 0,
    async send() {
      p.calls++;
      if (delayMs) await sleep(delayMs);
      if (failWith) throw failWith();
      return { messages: [{ id: `wamid.FAKE${p.calls}` }] };
    }
  };
  return p;
}

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_delivery_${Date.now()}` });
});
after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => { if (!skip) await coll().deleteMany({}); });

test('envio normal: uma chamada ao provedor; repetir não reenvia', { skip }, async () => {
  const prov = fakeProvider();
  const k = key();
  const a = await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: prov.send });
  const b = await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: prov.send });
  assert.equal(a.outcome, DeliveryOutcome.SENT);
  assert.equal(a.providerMessageId, 'wamid.FAKE1');
  assert.equal(b.outcome, DeliveryOutcome.ALREADY_SENT);
  assert.equal(b.providerMessageId, 'wamid.FAKE1');
  assert.equal(prov.calls, 1);

  const doc = await coll().findOne({ _id: k });
  assert.equal(doc.status, 'sent');
  assert.equal(doc.destinationHash, destinationHash('whatsapp', PHONE));
  assert.ok(!JSON.stringify(doc).includes(PHONE), 'registro não guarda o telefone');
});

test('concorrência: 10 execuções da mesma chave chamam o provedor uma vez', { skip }, async () => {
  const prov = fakeProvider({ delayMs: 50 });
  const k = key();
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: prov.send })));
  assert.equal(prov.calls, 1);
  assert.equal(results.filter(r => r.outcome === DeliveryOutcome.SENT).length, 1);
  for (const r of results.filter(x => x.outcome !== DeliveryOutcome.SENT)) {
    assert.ok([DeliveryOutcome.IN_PROGRESS, DeliveryOutcome.ALREADY_SENT].includes(r.outcome));
  }
});

test('falha que prova não-envio (4xx, ECONNREFUSED) libera nova tentativa', { skip }, async () => {
  const k = key();
  const bad = fakeProvider({ failWith: () => err('connect ECONNREFUSED 127.0.0.1:8080', { code: 'ECONNREFUSED' }) });
  await assert.rejects(guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: bad.send }), /ECONNREFUSED/);
  assert.equal((await coll().findOne({ _id: k })).status, 'failed');

  const good = fakeProvider();
  const r = await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: good.send });
  assert.equal(r.outcome, DeliveryOutcome.SENT);
  const doc = await coll().findOne({ _id: k });
  assert.equal(doc.attempts, 2);
  assert.deepEqual(doc.history.map(h => h.status), ['sending', 'failed', 'sending', 'sent']);
});

test('retentativas concorrentes depois de failed: uma só envia', { skip }, async () => {
  const k = key();
  const bad = fakeProvider({ failWith: () => err('Request failed', { response: { status: 429 } }) });
  await assert.rejects(guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: bad.send }));
  const prov = fakeProvider({ delayMs: 30 });
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: prov.send })));
  assert.equal(prov.calls, 1);
  assert.equal(results.filter(r => r.outcome === DeliveryOutcome.SENT).length, 1);
});

test('timeout/5xx: resultado incerto, sem reenvio automático', { skip }, async () => {
  for (const e of [
    () => err('timeout of 15000ms exceeded', { code: 'ECONNABORTED' }),
    () => err('socket hang up', { code: 'ECONNRESET' }),
    () => err('Bad gateway', { response: { status: 502 } }),
    () => err('algo inesperado')
  ]) {
    const k = key();
    const prov = fakeProvider({ failWith: e });
    const r1 = await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: prov.send });
    assert.equal(r1.outcome, DeliveryOutcome.UNCERTAIN);
    const again = fakeProvider();
    const r2 = await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: again.send });
    assert.equal(r2.outcome, DeliveryOutcome.UNCERTAIN);
    assert.equal(again.calls, 0, 'não reenviou');
    assert.equal((await coll().findOne({ _id: k })).status, 'unknown');
  }
});

test('reinício no meio do envio: lease vivo bloqueia; lease vencido vira incerto, sem reenvio', { skip }, async () => {
  const k = key();
  const t = new Date();
  await coll().insertOne({ _id: k, channel: 'whatsapp', status: 'sending', token: 'morto', leaseUntil: new Date(t.getTime() + 60_000), attempts: 1, history: [] });
  const prov = fakeProvider();
  assert.equal((await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: prov.send })).outcome, DeliveryOutcome.IN_PROGRESS);

  const later = () => new Date(t.getTime() + 120_000);
  const r = await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: prov.send, now: later });
  assert.equal(r.outcome, DeliveryOutcome.UNCERTAIN);
  assert.equal(prov.calls, 0);
  const doc = await coll().findOne({ _id: k });
  assert.equal(doc.status, 'unknown');
  assert.equal(doc.lastError, 'ATTEMPT_ABANDONED_LEASE_EXPIRED');
});

test('sucesso após o lease vencer ainda registra sent (o envio aconteceu)', { skip }, async () => {
  const k = key();
  let clock = new Date();
  const prov = {
    calls: 0,
    async send() {
      prov.calls++;
      // Outra execução, "no futuro", declara a tentativa abandonada.
      await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: async () => { throw new Error('não deveria'); }, now: () => new Date(clock.getTime() + 600_000) });
      return { messages: [{ id: 'wamid.TARDIO' }] };
    }
  };
  const r = await guardedSend({ channel: 'whatsapp', deliveryKey: k, destination: PHONE, send: prov.send, now: () => clock });
  assert.equal(r.outcome, DeliveryOutcome.SENT);
  assert.equal((await coll().findOne({ _id: k })).status, 'sent');
});

test('resolução manual de incerto: auditada; failed libera, sent encerra', { skip }, async () => {
  const mk = async () => {
    const k = key();
    await guardedSend({ channel: 'email', deliveryKey: k, destination: 'ficticio@example.invalid', send: async () => { throw err('ETIMEDOUT', { code: 'ETIMEDOUT' }); } });
    return k;
  };
  const k1 = await mk();
  await assert.rejects(resolveUncertainDelivery(k1, { as: 'failed' }), /ACTOR_REQUIRED/);
  assert.equal(await resolveUncertainDelivery(k1, { as: 'failed', by: 'admin-ficticio', note: 'confirmado no painel do provedor' }), true);
  const prov = fakeProvider();
  assert.equal((await guardedSend({ channel: 'email', deliveryKey: k1, destination: 'x', send: prov.send })).outcome, DeliveryOutcome.SENT);
  const h = (await coll().findOne({ _id: k1 })).history.find(x => x.reason === 'manual_resolution');
  assert.equal(h.by, 'admin-ficticio');

  const k2 = await mk();
  await resolveUncertainDelivery(k2, { as: 'sent', by: 'admin-ficticio' });
  const p2 = fakeProvider();
  assert.equal((await guardedSend({ channel: 'email', deliveryKey: k2, destination: 'x', send: p2.send })).outcome, DeliveryOutcome.ALREADY_SENT);
  assert.equal(p2.calls, 0);
  assert.equal(await resolveUncertainDelivery(k2, { as: 'failed', by: 'x' }), false, 'só resolve o que está incerto');
});

test('classificação: só erro que prova não-envio libera retry', { skip: false }, () => {
  assert.equal(isDefinitelyNotSent(err('x', { response: { status: 400 } })), true);
  assert.equal(isDefinitelyNotSent(err('x', { status: 408 })), false);
  assert.equal(isDefinitelyNotSent(err('x', { response: { status: 503 } })), false);
  assert.equal(isDefinitelyNotSent(err('Número de telefone inválido: curto')), true);
  assert.equal(isDefinitelyNotSent(err('WhatsApp Web não está conectado (status: close). Escaneie o QR code.')), true);
  assert.equal(isDefinitelyNotSent(err('WhatsApp Web não está conectado (status: close) e VPS fallback falhou: timeout')), false);
  assert.equal(isDefinitelyNotSent(err('timeout', { code: 'ETIMEDOUT' })), false);
});
