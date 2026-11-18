// Fila `whatsapp-send` (WhatsApp Web) passando pelo guarda de entregas.
// Provedor SIMULADO, Mongo descartável em loopback, dados fictícios.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//     node --test --test-force-exit tests/delivery/whatsappWebDelivery.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { DeliveryOutcome, DELIVERY_COLLECTION } from '../../infrastructure/delivery/deliveryGuard.js';
import { deliverWhatsAppWebJob } from '../../workers/entrypoints/whatsappWebDelivery.js';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(URI).hostname)) {
  throw new Error('MONGO_TEST_URI precisa ser loopback');
}

const PHONE = '5562900000001'; // fictício
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const coll = () => mongoose.connection.db.collection(DELIVERY_COLLECTION);
let n = 0;
const jobId = (p) => `${p}-teste-${process.pid}-${n++}`;

// Imita services/whatsappWebJsService.sendMessage: devolve { success, messageId }.
function fakeWeb({ delayMs = 0, failWith = null } = {}) {
  const p = {
    calls: 0,
    async send() {
      p.calls++;
      if (delayMs) await sleep(delayMs);
      if (failWith) { const e = failWith(p.calls); if (e) throw e; }
      return { success: true, messageId: `true_${PHONE}@c.us_FAKE${p.calls}` };
    }
  };
  return p;
}
const notSent = (msg) => Object.assign(new Error(msg), { deliveryNotSent: true });

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_wweb_delivery_${Date.now()}` });
});
after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => { if (!skip) await coll().deleteMany({}); });

test('job reprocessado (retry/reentrega) não reenvia e devolve o messageId original', { skip }, async () => {
  const web = fakeWeb();
  const id = jobId('attconf');
  const a = await deliverWhatsAppWebJob({ jobId: id, phone: PHONE, send: web.send });
  const b = await deliverWhatsAppWebJob({ jobId: id, phone: PHONE, send: web.send });
  assert.equal(a.outcome, DeliveryOutcome.SENT);
  assert.equal(a.result.messageId, `true_${PHONE}@c.us_FAKE1`);
  assert.equal(b.outcome, DeliveryOutcome.ALREADY_SENT);
  assert.equal(b.result.alreadySent, true);
  assert.equal(b.result.messageId, a.result.messageId);
  assert.equal(web.calls, 1);
  const doc = await coll().findOne({ _id: `wweb:send:${id}` });
  assert.equal(doc.status, 'sent');
  // O id do WhatsApp Web ("true_<telefone>@c.us_<id>") contém o número. Ele é
  // guardado porque a enquete de confirmação casa o voto por esse id; fora dele,
  // o registro não tem telefone (destino só como hash). Ver docs/ENVIOS_ANTI_REENVIO.md.
  const { providerMessageId, ...rest } = doc;
  assert.equal(providerMessageId, a.result.messageId);
  assert.equal(JSON.stringify(rest).includes(PHONE), false, 'fora do messageId, registro não guarda o telefone');
});

test('timeout depois de enviar: fica incerto e o retry NÃO reenvia', { skip }, async () => {
  const web = fakeWeb({ failWith: (call) => call === 1 ? new Error('Protocol error: Runtime.callFunctionOn timed out') : null });
  const id = jobId('birthday');
  const a = await deliverWhatsAppWebJob({ jobId: id, phone: PHONE, send: web.send });
  const b = await deliverWhatsAppWebJob({ jobId: id, phone: PHONE, send: web.send });
  assert.equal(a.outcome, DeliveryOutcome.UNCERTAIN);
  assert.equal(a.result, null);
  assert.equal(b.outcome, DeliveryOutcome.UNCERTAIN);
  assert.equal(web.calls, 1);
  assert.equal((await coll().findOne({ _id: `wweb:send:${id}` })).status, 'unknown');
});

test('falha que prova não-envio (desconectado) lança; o retry do BullMQ envia', { skip }, async () => {
  const web = fakeWeb({ failWith: (call) => call === 1 ? notSent('WhatsApp não está conectado') : null });
  const id = jobId('monthly');
  await assert.rejects(deliverWhatsAppWebJob({ jobId: id, phone: PHONE, send: web.send }), /não está conectado/);
  const b = await deliverWhatsAppWebJob({ jobId: id, phone: PHONE, send: web.send });
  assert.equal(b.outcome, DeliveryOutcome.SENT);
  assert.equal(web.calls, 2);
  const doc = await coll().findOne({ _id: `wweb:send:${id}` });
  assert.equal(doc.status, 'sent');
  assert.equal(doc.attempts, 2);
});

test('número sem WhatsApp também é não-envio comprovado', { skip }, async () => {
  const web = fakeWeb({ failWith: () => notSent(`Número ${PHONE} não possui WhatsApp`) });
  const id = jobId('famsum');
  await assert.rejects(deliverWhatsAppWebJob({ jobId: id, phone: PHONE, send: web.send }));
  assert.equal((await coll().findOne({ _id: `wweb:send:${id}` })).status, 'failed');
});

test('dois workers com o mesmo job ao mesmo tempo: uma chamada ao provedor', { skip }, async () => {
  const web = fakeWeb({ delayMs: 80 });
  const id = jobId('attconf');
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    deliverWhatsAppWebJob({ jobId: id, phone: PHONE, send: web.send })));
  assert.equal(web.calls, 1);
  const outcomes = results.map(r => r.outcome).sort();
  assert.equal(outcomes.filter(o => o === DeliveryOutcome.SENT).length, 1);
  assert.equal(outcomes.filter(o => o === DeliveryOutcome.IN_PROGRESS).length, 4);
});

test('jobs diferentes para o mesmo telefone são envios distintos', { skip }, async () => {
  const web = fakeWeb();
  await deliverWhatsAppWebJob({ jobId: jobId('a'), phone: PHONE, send: web.send });
  await deliverWhatsAppWebJob({ jobId: jobId('b'), phone: PHONE, send: web.send });
  assert.equal(web.calls, 2);
});
