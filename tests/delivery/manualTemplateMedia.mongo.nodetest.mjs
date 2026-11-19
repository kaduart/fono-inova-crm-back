// Item 4: template e mídia MANUAIS pelo controller real (whatsappController.sendTemplate /
// sendMedia) com Idempotency-Key. Provedor SIMULADO (mock do módulo whatsappService:
// conta chamadas, atrasa, dá timeout). MongoDB descartável em loopback. Dados fictícios.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' \
//     node --experimental-test-module-mocks --test --test-force-exit \
//     tests/delivery/manualTemplateMedia.mongo.nodetest.mjs
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI) {
  const host = new URL(URI).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('MONGO_TEST_URI precisa ser loopback');
}
// Ambiente fictício: o controller importa serviços que exigem estas variáveis no carregamento.
process.env.INTERNAL_BASE_URL ??= 'http://127.0.0.1:9';
process.env.REDIS_URL ??= process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6379';
// SDKs instanciados no import exigem uma string; nenhuma é credencial real e nada vai à rede.
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY']) process.env[k] ??= 'ficticia-sem-acesso';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE = '5562900000000'; // fictício

// ── provedor simulado ──
const provider = { template: 0, media: 0, behaviour: null };
const reset = () => { provider.template = 0; provider.media = 0; provider.behaviour = null; };
const run = async (kind) => {
  provider[kind]++;
  if (provider.behaviour) return provider.behaviour(kind);
  return { messages: [{ id: `wamid.SIM.${kind}.${Math.random().toString(36).slice(2)}` }] };
};
const real = await import('../../services/whatsappService.js');
mock.module('../../services/whatsappService.js', {
  namedExports: {
    ...real,
    sendTemplateMessage: () => run('template'),
    sendWhatsAppMediaMessage: () => run('media'),
  },
});
mock.module('../../config/socket.js', { namedExports: { getIo: () => ({ emit() {}, to: () => ({ emit() {} }) }) } });

const { whatsappController } = await import('../../controllers/whatsappController.js');
const { DELIVERY_COLLECTION } = await import('../../infrastructure/delivery/deliveryGuard.js');

function req({ key, body, file }) {
  const headers = key ? { 'idempotency-key': key } : {};
  return { headers, body, file, user: { _id: 'atendente-1' }, get: (n) => headers[n.toLowerCase()] };
}
function res() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.header = (k, v) => { r.headers[k] = v; return r; };
  r.set = r.header;
  return r;
}
const tpl = (key, extra = {}) => req({ key, body: { phone: PHONE, template: 'lembrete_ficticio', params: [{ type: 'text', text: 'Fulano' }], ...extra } });
const media = (key, content = 'conteudo-ficticio') => req({ key, body: { phone: PHONE, type: 'document' }, file: { buffer: Buffer.from(content), originalname: 'arquivo.pdf', mimetype: 'application/pdf' } });

before(async () => { if (!skip) await mongoose.connect(URI, { dbName: `crm_envios_tpl_midia_${Date.now()}` }); });
after(async () => { if (!skip) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
beforeEach(async () => { reset(); if (!skip) await mongoose.connection.db.collection(DELIVERY_COLLECTION).deleteMany({}); });

test('template: mesma chave duas vezes chama o provedor uma vez; 2ª resposta é duplicada', { skip }, async () => {
  const r1 = res(); await whatsappController.sendTemplate(tpl('k-tpl-0001'), r1);
  const r2 = res(); await whatsappController.sendTemplate(tpl('k-tpl-0001'), r2);
  assert.equal(provider.template, 1);
  assert.equal(r1.body.success, true);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.duplicated, true);
});

test('template: 5 cliques simultâneos com a mesma chave = 1 envio', { skip }, async () => {
  provider.behaviour = async () => { await sleep(150); return { messages: [{ id: `wamid.SIM.conc.${Date.now()}` }] }; };
  const rs = Array.from({ length: 5 }, res);
  await Promise.all(rs.map((r) => whatsappController.sendTemplate(tpl('k-tpl-conc'), r)));
  assert.equal(provider.template, 1);
  for (const r of rs) assert.ok([200, 409].includes(r.statusCode));
});

test('template: timeout do provedor fica incerto (409) e o retry não reenvia', { skip }, async () => {
  provider.behaviour = async () => { const e = new Error('timeout of 15000ms exceeded'); e.code = 'ECONNABORTED'; throw e; };
  const r1 = res(); await whatsappController.sendTemplate(tpl('k-tpl-timeout'), r1);
  const r2 = res(); await whatsappController.sendTemplate(tpl('k-tpl-timeout'), r2);
  assert.equal(provider.template, 1);
  assert.equal(r2.statusCode, 409);
  assert.equal(r2.body.code, 'DELIVERY_UNCERTAIN');
});

test('template: sem chave (cliente antigo) envia como antes; chave inválida = 400 sem envio', { skip }, async () => {
  await whatsappController.sendTemplate(tpl(null), res());
  await whatsappController.sendTemplate(tpl(null), res());
  assert.equal(provider.template, 2);
  const bad = res(); await whatsappController.sendTemplate(tpl('curta'), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(provider.template, 2);
});

test('mídia: mesma chave e mesmo arquivo = 1 envio; mesma chave com OUTRO arquivo = outro envio', { skip }, async () => {
  await whatsappController.sendMedia(media('k-midia-0001'), res());
  const again = res(); await whatsappController.sendMedia(media('k-midia-0001'), again);
  assert.equal(provider.media, 1);
  assert.equal(again.body.duplicated, true);
  await whatsappController.sendMedia(media('k-midia-0001', 'outro-arquivo'), res());
  assert.equal(provider.media, 2);
});

test('mídia: timeout fica incerto e o retry não reenvia; desconectado libera o reenvio', { skip }, async () => {
  provider.behaviour = async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; };
  await whatsappController.sendMedia(media('k-midia-timeout'), res());
  const r2 = res(); await whatsappController.sendMedia(media('k-midia-timeout'), r2);
  assert.equal(provider.media, 1);
  assert.equal(r2.statusCode, 409);

  let fail = true;
  provider.behaviour = async () => { if (fail) throw new Error('WhatsApp Web não está conectado (status: disconnected). Escaneie o QR code.'); return { messages: [{ id: `wamid.SIM.ok.${Date.now()}` }] }; };
  const n0 = provider.media;
  await whatsappController.sendMedia(media('k-midia-desconect'), res());
  fail = false;
  const ok = res(); await whatsappController.sendMedia(media('k-midia-desconect'), ok);
  assert.equal(provider.media - n0, 2);
  assert.equal(ok.body.success, true);
});
