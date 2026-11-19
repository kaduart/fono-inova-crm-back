// Item 4: envio MANUAL de WhatsApp com Idempotency-Key e e-mail de convênio
// com reserva atômica por jobId. Provedores SIMULADOS (contadores, atrasos,
// timeouts). MongoDB descartável em loopback. Dados fictícios.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' \
//     node --test --test-force-exit tests/delivery/manualEmail.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { DELIVERY_COLLECTION, DeliveryOutcome } from '../../infrastructure/delivery/deliveryGuard.js';
import {
  sendManualOnce, manualSendResponse, manualIdempotencyKey, manualDeliveryKey
} from '../../services/communication/manualSendOnce.js';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI) {
  const host = new URL(URI).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('MONGO_TEST_URI precisa ser loopback');
}
process.env.EMAIL_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_ficticio_isolado'; // cliente nunca chega à rede: sendEmail é simulado
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE = '5562900000000'; // fictício

/** Provedor simulado: conta chamadas; comportamento por chamada. */
function fakeProvider(behaviour = async () => ({ messages: [{ id: `wamid.SIM.${Math.random().toString(36).slice(2)}` }] })) {
  const p = { calls: 0 };
  p.send = async () => { p.calls++; return behaviour(p.calls); };
  return p;
}

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_envios_manual_${Date.now()}` });
});
after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => { if (!skip) await mongoose.connection.db.collection(DELIVERY_COLLECTION).deleteMany({}); });

test('Idempotency-Key: ausente = legado; inválido = erro; válido = chave', () => {
  const req = (h) => ({ headers: h, get: (n) => h[n.toLowerCase()] });
  assert.deepEqual(manualIdempotencyKey(req({})), { key: null });
  assert.match(manualIdempotencyKey(req({ 'idempotency-key': 'curta' })).error, /inválido/);
  assert.deepEqual(manualIdempotencyKey(req({ 'idempotency-key': 'wa-manual:abc12345' })), { key: 'wa-manual:abc12345' });
  // Telefone não aparece na chave (só hash).
  assert.doesNotMatch(manualDeliveryKey({ actorId: 'u1', key: 'k1234567', destination: PHONE }), new RegExp(PHONE));
});

test('repetição: mesma chave não reenvia e devolve 200 duplicado com o messageId original', { skip }, async () => {
  const p = fakeProvider();
  const first = await sendManualOnce({ key: 'k-repete-1', actorId: 'u1', destination: PHONE, send: p.send });
  assert.equal(first.outcome, DeliveryOutcome.SENT);
  const again = await sendManualOnce({ key: 'k-repete-1', actorId: 'u1', destination: PHONE, send: p.send });
  assert.equal(again.outcome, DeliveryOutcome.ALREADY_SENT);
  assert.equal(p.calls, 1);
  const resp = manualSendResponse(again.outcome, again.providerMessageId);
  assert.equal(resp.status, 200);
  assert.equal(resp.body.duplicated, true);
  assert.equal(resp.body.messageId, first.providerMessageId);
});

test('concorrência: duplo clique / 10 requisições iguais chamam o provedor uma vez', { skip }, async () => {
  const p = fakeProvider(async () => { await sleep(150); return { messages: [{ id: 'wamid.SIM.conc' }] }; });
  const rs = await Promise.all(Array.from({ length: 10 }, () =>
    sendManualOnce({ key: 'k-concorrente', actorId: 'u1', destination: PHONE, send: p.send })));
  assert.equal(p.calls, 1);
  assert.equal(rs.filter((r) => r.outcome === DeliveryOutcome.SENT).length, 1);
  for (const r of rs.filter((x) => x.outcome !== DeliveryOutcome.SENT)) {
    assert.ok([DeliveryOutcome.IN_PROGRESS, DeliveryOutcome.ALREADY_SENT].includes(r.outcome));
    assert.ok([200, 409].includes(manualSendResponse(r.outcome).status));
  }
});

test('resposta incerta do provedor (timeout): 409 incerto e o retry NÃO reenvia', { skip }, async () => {
  const p = fakeProvider(async () => { const e = new Error('timeout of 15000ms exceeded'); e.code = 'ECONNABORTED'; throw e; });
  const r1 = await sendManualOnce({ key: 'k-incerto-1', actorId: 'u1', destination: PHONE, send: p.send });
  assert.equal(r1.outcome, DeliveryOutcome.UNCERTAIN);
  const resp = manualSendResponse(r1.outcome);
  assert.equal(resp.status, 409);
  assert.equal(resp.body.code, 'DELIVERY_UNCERTAIN');
  assert.equal(resp.body.retryable, false);
  const r2 = await sendManualOnce({ key: 'k-incerto-1', actorId: 'u1', destination: PHONE, send: p.send });
  assert.equal(r2.outcome, DeliveryOutcome.UNCERTAIN);
  assert.equal(p.calls, 1);
});

test('reinício no meio do envio: tentativa abandonada vira incerta, sem reenvio', { skip }, async () => {
  const key = manualDeliveryKey({ actorId: 'u1', key: 'k-reinicio', destination: PHONE });
  // Estado que um processo derrubado deixa: reservado, prazo vencido, sem resultado.
  await mongoose.connection.db.collection(DELIVERY_COLLECTION).insertOne({
    _id: key, channel: 'whatsapp', status: 'sending', token: 'morto', attempts: 1,
    leaseUntil: new Date(Date.now() - 1000), createdAt: new Date(), history: []
  });
  const p = fakeProvider();
  const r = await sendManualOnce({ key: 'k-reinicio', actorId: 'u1', destination: PHONE, send: p.send });
  assert.equal(r.outcome, DeliveryOutcome.UNCERTAIN);
  assert.equal(p.calls, 0);
});

test('falha que prova não-envio (desconectado) libera o reenvio com a mesma chave', { skip }, async () => {
  let fail = true;
  const p = fakeProvider(async () => {
    if (fail) throw new Error('WhatsApp Web não está conectado (status: disconnected). Escaneie o QR code.');
    return { messages: [{ id: 'wamid.SIM.ok' }] };
  });
  await assert.rejects(() => sendManualOnce({ key: 'k-nao-saiu', actorId: 'u1', destination: PHONE, send: p.send }), /não está conectado/);
  fail = false;
  const r = await sendManualOnce({ key: 'k-nao-saiu', actorId: 'u1', destination: PHONE, send: p.send });
  assert.equal(r.outcome, DeliveryOutcome.SENT);
  assert.equal(p.calls, 2);
});

test('operações legítimas distintas: outra chave, outro número ou sem chave enviam', { skip }, async () => {
  const p = fakeProvider();
  await sendManualOnce({ key: 'k-msg-1', actorId: 'u1', destination: PHONE, send: p.send });
  await sendManualOnce({ key: 'k-msg-2', actorId: 'u1', destination: PHONE, send: p.send });
  await sendManualOnce({ key: 'k-msg-1', actorId: 'u1', destination: '5562900000001', send: p.send });
  await sendManualOnce({ key: null, actorId: 'u1', destination: PHONE, send: p.send });
  await sendManualOnce({ key: null, actorId: 'u1', destination: PHONE, send: p.send });
  assert.equal(p.calls, 5);
});

// ── E-mail de convênio: EmailDeliveryProvider.executeDelivery real, provedor Resend simulado ──
async function seedCommunication() {
  const db = mongoose.connection.db;
  const communicationId = new mongoose.Types.ObjectId();
  await db.collection('insurancecommunications').insertOne({
    _id: communicationId, insuranceProvider: 'convenio-ficticio', purpose: 'authorization', status: 'ready'
  });
  await db.collection('communicationpackages').insertOne({
    communicationId, attachments: [], attempt: 0
  });
  return communicationId;
}

test('e-mail convênio: dois workers com o mesmo job ao mesmo tempo enviam UMA vez e deixam UM registro', { skip }, async () => {
  const { ResendProvider } = await import('../../services/email/EmailProviderFactory.js');
  const { EmailDeliveryProvider } = await import('../../services/communication/delivery/EmailDeliveryProvider.js');
  const original = ResendProvider.prototype.sendEmail;
  let calls = 0;
  ResendProvider.prototype.sendEmail = async () => { calls++; await sleep(200); return { success: true, messageId: '<sim@local>', resendMessageId: 'sim-1' }; };
  try {
    const communicationId = await seedCommunication();
    const provider = new EmailDeliveryProvider();
    const job = { communicationId, to: 'convenio@exemplo.invalid', userId: new mongoose.Types.ObjectId(), jobId: 'job-email-conc-1' };
    const rs = await Promise.all([provider.executeDelivery(job), provider.executeDelivery(job), provider.executeDelivery(job)]);
    assert.equal(calls, 1, 'provedor chamado uma vez');
    assert.equal(rs.filter((r) => r.success && !r.duplicate).length, 1);
    const logs = await mongoose.connection.db.collection('communicationemaillogs').find({ jobId: 'job-email-conc-1' }).toArray();
    assert.equal(logs.length, 1, 'um registro na aba Envios');
    assert.equal(logs[0].status, 'success');
    // Reentrega do BullMQ depois do sucesso: não reenvia.
    const again = await provider.executeDelivery(job);
    assert.equal(again.success, true);
    assert.equal(calls, 1);
  } finally {
    ResendProvider.prototype.sendEmail = original;
  }
});

test('e-mail convênio: timeout do provedor fica incerto e o retry do job não reenvia', { skip }, async () => {
  const { ResendProvider } = await import('../../services/email/EmailProviderFactory.js');
  const { EmailDeliveryProvider } = await import('../../services/communication/delivery/EmailDeliveryProvider.js');
  const original = ResendProvider.prototype.sendEmail;
  let calls = 0;
  ResendProvider.prototype.sendEmail = async () => { calls++; const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; };
  try {
    const communicationId = await seedCommunication();
    const provider = new EmailDeliveryProvider();
    const job = { communicationId, to: 'convenio@exemplo.invalid', userId: new mongoose.Types.ObjectId(), jobId: 'job-email-incerto-1' };
    const r1 = await provider.executeDelivery(job);
    assert.equal(r1.success, false);
    const r2 = await provider.executeDelivery(job);
    assert.equal(r2.success, false);
    assert.equal(calls, 1, 'resultado incerto não é reenviado sozinho');
    const d = await mongoose.connection.db.collection(DELIVERY_COLLECTION).findOne({ _id: 'email:convenio:job-email-incerto-1' });
    assert.equal(d.status, 'unknown');
  } finally {
    ResendProvider.prototype.sendEmail = original;
  }
});
