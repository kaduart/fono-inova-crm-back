// Motor whatsapp-web.js com uma biblioteca FALSA (sem Chrome, sem sessão real): ciclo de vida, reinício,
// conflito de sessão, eventos normalizados e envio (texto, enquete, falhas que provam "não saiu").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createWhatsAppEngine, chromeArgs } from '../src/engine.js';

function fakeTimers() {
  let t = 0; let seq = 0;
  const q = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = { id: ++seq }; q.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { q.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); t = next[1].at; next[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

function fakeLib({ initialize = async () => {}, numberIds = { '5562999990000': '5562999990000@c.us' } } = {}) {
  const clients = [];
  class Client extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.sent = []; this.destroyed = false; clients.push(this); }
    initialize() { return initialize(this); }
    async destroy() { this.destroyed = true; }
    async getState() { return this.state || null; }
    async getNumberId(p) { return numberIds[p] ? { _serialized: numberIds[p] } : null; }
    async sendMessage(to, content, o) {
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      if (content instanceof Poll && this.pollFails) throw new Error('poll indisponível');
      this.sent.push({ to, content, o });
      return { id: { _serialized: `true_${to}_${this.sent.length}` } };
    }
    async getContactLidAndPhone(ids) { return ids.map((id) => ({ lid: id, pn: id === '999@lid' ? '5562988887777@c.us' : null })); }
    async logout() { this.loggedOut = true; }
  }
  class LocalAuth { constructor(o) { this.o = o; } }
  class Poll { constructor(q, opts, o) { this.q = q; this.options = opts; this.o = o; } }
  return { lib: { Client, LocalAuth, Poll }, clients, Poll };
}

const quiet = { log() {}, warn() {}, error() {} };
const mk = (over = {}) => {
  const timers = fakeTimers();
  const f = fakeLib(over.libOpts);
  const events = [];
  const engine = createWhatsAppEngine({ lib: f.lib, authPath: '/tmp/x', toQrDataUrl: async (q) => `data:${q}`, logger: quiet, catchUpDelayMs: 1e12, ...timers, ...over.engine });
  engine.setSink((type, data) => { events.push({ type, data }); });
  return { engine, timers, events, ...f };
};

test('Client criado com LocalAuth na pasta da sessão, sem takeover de conflito e com teto de heap', async () => {
  const { engine, clients } = mk();
  await engine.start();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].opts.authStrategy.o.dataPath, '/tmp/x');
  assert.equal(clients[0].opts.takeoverOnConflict, false);
  assert.ok(clients[0].opts.puppeteer.args.includes('--js-flags=--max-old-space-size=1024'));
  assert.deepEqual(chromeArgs({ jsHeapMb: 0 }).filter((a) => a.startsWith('--js-flags')), []);
});

test('qr → status qr com imagem; ready → pronto', async () => {
  const { engine, clients } = mk();
  await engine.start();
  clients[0].emit('qr', 'abc');
  await new Promise((r) => setImmediate(r));
  assert.equal((await engine.getStatus()).status, 'qr');
  assert.equal((await engine.getStatus()).qrCode, 'data:abc');
  clients[0].emit('ready');
  const st = await engine.getStatus();
  assert.equal(st.ready, true);
  assert.equal(st.qrCode, null);
});

test('mensagens viram eventos normalizados (contato, @lid resolvido, grupo ignorado, miniatura removida)', async () => {
  const { engine, clients, events } = mk();
  await engine.start();
  const c = clients[0];
  c.emit('ready');
  c.emit('message', { from: '5562999990000@c.us', body: 'oi', timestamp: 10, id: { _serialized: 'm1' }, _data: { notifyName: 'Ana', ctwaContext: { sourceId: '1', thumbnail: 'AAAA' } } });
  c.emit('message', { from: '999@lid', body: 'vim do anúncio', id: { _serialized: 'm2' }, client: c, _data: {} });
  c.emit('message', { from: '123@g.us', body: 'grupo', id: { _serialized: 'm3' }, _data: {} });
  c.emit('message_create', { fromMe: true, to: '5562999990000@c.us', id: { _serialized: 'o1' }, timestamp: 11 });
  c.emit('vote_update', { voter: '5562999990000@c.us', selectedOptions: [{ name: 'Confirmar presença ✅' }], parentMsgKey: { _serialized: 'p1' }, interractedAtTs: 5 });
  await new Promise((r) => setTimeout(r, 20));
  const inbound = events.filter((e) => e.type === 'message.inbound').map((e) => e.data);
  assert.equal(inbound.length, 2);
  assert.equal(inbound[0].phone, '5562999990000');
  assert.equal(inbound[0].ctwa.thumbnail, undefined);
  assert.equal(inbound[0].ctwa.sourceId, '1');
  assert.equal(inbound.find((d) => d.waMessageId === 'm2').phone, '5562988887777');
  assert.deepEqual(events.find((e) => e.type === 'message.outbound').data, { waMessageId: 'o1', chatId: '5562999990000@c.us', phone: '5562999990000', timestamp: 11 });
  assert.equal(events.find((e) => e.type === 'poll.vote').data.pollMessageId, 'p1');
});

test('envio: desconectado / número inválido / sem WhatsApp provam que nada saiu', async () => {
  const { engine, clients } = mk();
  await assert.rejects(engine.sendMessage('5562999990000', 'oi'), { code: 'NOT_CONNECTED', deliveryNotSent: true });
  await engine.start();
  clients[0].emit('ready');
  await assert.rejects(engine.sendMessage('abc', 'oi'), { code: 'INVALID_NUMBER', deliveryNotSent: true });
  await assert.rejects(engine.sendMessage('5562911112222', 'oi'), { code: 'NO_WHATSAPP', deliveryNotSent: true });
  const r = await engine.sendMessage('5562999990000', 'oi');
  assert.equal(r.success, true);
  assert.match(r.messageId, /^true_/);
});

test('envio com enquete vinda do CRM: texto + enquete; sem enquete, cai no texto alternativo', async () => {
  const { engine, clients, Poll } = mk();
  await engine.start();
  const c = clients[0];
  c.emit('ready');
  const poll = { question: 'Confirme', options: ['Sim', 'Não'], fallbackText: 'Responda 1 ou 2' };
  await engine.sendMessage('5562999990000', 'lembrete', { poll });
  assert.equal(c.sent[0].content, 'lembrete');
  assert.ok(c.sent[1].content instanceof Poll);
  assert.deepEqual(c.sent[1].content.options, ['Sim', 'Não']);
  c.pollFails = true;
  await engine.sendMessage('5562999990000', 'lembrete 2', { poll });
  assert.equal(c.sent.at(-1).content, 'Responda 1 ou 2');
});

test('erro no meio do envio (Chrome caiu) NÃO é marcado como "não saiu" (fica incerto para a API)', async () => {
  const { engine, clients } = mk();
  await engine.start();
  clients[0].emit('ready');
  clients[0].failNext = new Error('Protocol error: Target closed');
  await assert.rejects(engine.sendMessage('5562999990000', 'oi'), (e) => !e.deliveryNotSent && !e.code);
});

test('desconexão → reinício dentro do processo, com espera, e Client novo', async () => {
  const { engine, clients, timers } = mk();
  await engine.start();
  clients[0].emit('ready');
  clients[0].emit('disconnected', 'NAVIGATION');
  await new Promise((r) => setImmediate(r));
  assert.equal(clients[0].destroyed, true);
  assert.equal((await engine.getStatus()).status, 'restarting');
  assert.equal(clients.length, 1);
  await timers.advance(10_000);
  assert.equal(clients.length, 2);
});

test('init travado (initialize nunca resolve) → reinicia após o watchdog', async () => {
  const { engine, clients, timers } = mk({ libOpts: { initialize: () => new Promise(() => {}) }, engine: { initTimeoutMs: 1000 } });
  engine.start();
  await new Promise((r) => setImmediate(r));
  await timers.advance(1000);
  assert.equal(clients[0].destroyed, true);
  await timers.advance(10_000);
  assert.equal(clients.length, 2);
});

test('CONFLICT (mesma sessão aberta em outro lugar): para, mostra conflito e NÃO retoma sozinho', async () => {
  const { engine, clients, timers } = mk();
  await engine.start();
  clients[0].emit('ready');
  clients[0].emit('change_state', 'CONFLICT');
  await new Promise((r) => setImmediate(r));
  const st = await engine.getStatus();
  assert.equal(st.status, 'conflict');
  assert.equal(st.ready, false);
  await timers.advance(60 * 60_000);
  assert.equal(clients.length, 1, 'não pode abrir outro Chrome para disputar a sessão');
  await engine.reconnect(); // decisão humana (botão no ERP)
  await new Promise((r) => setImmediate(r));
  assert.equal(clients.length, 2);
});

test('reinícios demais em pouco tempo → status failed visível, sem novo Chrome até reconexão manual', async () => {
  const { engine, clients, timers } = mk({ libOpts: { initialize: async () => { throw new Error('Target closed'); } }, engine: { maxRestartsPerWindow: 3, restartBackoffMs: [1000] } });
  await engine.start();
  for (let i = 0; i < 6; i++) await timers.advance(1000);
  const st = await engine.getStatus();
  assert.equal(st.status, 'failed');
  const n = clients.length;
  await timers.advance(60 * 60_000);
  assert.equal(clients.length, n);
  assert.match(st.lastDisconnectReason, /reinícios/);
});

test('stop: destrói o Chrome e nenhum timer reabre depois', async () => {
  const { engine, clients, timers } = mk();
  await engine.start();
  clients[0].emit('disconnected', 'x');
  await engine.stop();
  await timers.advance(10 * 60_000);
  assert.equal(clients.length, 1);
  assert.equal((await engine.getStatus()).status, 'stopped');
});
