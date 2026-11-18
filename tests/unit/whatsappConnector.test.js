/**
 * Conector WhatsApp externo (18/11/2026): contrato, idempotência, outbox, cliente e cenários com simulador.
 * Tudo em processo, com HTTP real em porta efêmera e WhatsApp falso (sem Chrome, sem MongoDB, sem Redis).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  signRequest, verifySignature, buildEvent, eventIdFor, jobIdForEvent, SendState, FailCode, SIGNATURE_HEADER,
} from '../../services/whatsappConnector/contract.js';
import { IdempotencyStore } from '../../whatsapp-connector/idempotencyStore.js';
import { EventOutbox } from '../../whatsapp-connector/eventOutbox.js';
import { createConnectorApp, listen, classifySendError } from '../../whatsapp-connector/app.js';
import { createFakeEngine } from '../../whatsapp-connector/simulator.js';
import { createConnectorClient } from '../../services/whatsappConnector/client.js';
import { receiveConnectorEvents } from '../../services/whatsappConnector/eventsReceiver.js';

const SECRET = 'segredo-de-teste';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conn-'));
const quiet = { info() {}, warn() {}, error() {} };

describe('contrato: assinatura HMAC', () => {
  const req = { method: 'POST', path: '/v1/messages', body: '{"a":1}', now: 1_700_000_000_000 };

  it('assina e confere', () => {
    const h = signRequest(SECRET, req);
    expect(verifySignature(SECRET, h, req)).toEqual({ ok: true });
  });
  it('recusa corpo, caminho ou método trocados', () => {
    const h = signRequest(SECRET, req);
    expect(verifySignature(SECRET, h, { ...req, body: '{"a":2}' }).ok).toBe(false);
    expect(verifySignature(SECRET, h, { ...req, path: '/v1/status' }).ok).toBe(false);
    expect(verifySignature(SECRET, h, { ...req, method: 'GET' }).ok).toBe(false);
  });
  it('recusa fora da janela de 5 min (replay)', () => {
    const h = signRequest(SECRET, req);
    expect(verifySignature(SECRET, h, { ...req, now: req.now + 301_000 })).toEqual({ ok: false, reason: 'fora_da_janela' });
  });
  it('recusa segredo errado e header ausente; aceita rotação (lista)', () => {
    const h = signRequest(SECRET, req);
    expect(verifySignature('outro', h, req).ok).toBe(false);
    expect(verifySignature(SECRET, undefined, req).reason).toBe('assinatura_ausente');
    expect(verifySignature(['novo', SECRET], h, req).ok).toBe(true);
  });
  it('eventId estável: a mesma mensagem relida gera o mesmo id; jobId sem ":"', () => {
    const a = eventIdFor('message.inbound', { waMessageId: 'false_5562@c.us_ABC', source: 'live' });
    const b = eventIdFor('message.inbound', { waMessageId: 'false_5562@c.us_ABC', source: 'catchup' });
    expect(a).toBe(b);
    expect(jobIdForEvent(a)).not.toContain(':');
    const v1 = eventIdFor('poll.vote', { pollMessageId: 'p', voterPhone: '55', optionName: 'x', respondedAtMs: 1 });
    expect(v1).toBe(eventIdFor('poll.vote', { optionName: 'x', voterPhone: '55', pollMessageId: 'p', respondedAtMs: 1 }));
  });
});

describe('idempotência no disco', () => {
  it('mesmo requestId devolve o registro; conteúdo diferente é conflito', () => {
    const s = new IdempotencyStore({ file: path.join(tmpDir(), 's.json'), logger: quiet });
    expect(s.begin('r1', 'f1').reserved).toBe(true);
    expect(s.begin('r1', 'f1')).toMatchObject({ reserved: false, record: { state: SendState.IN_PROGRESS } });
    expect(s.begin('r1', 'f2').conflict).toBe(true);
  });
  it('reinício: envio que estava em andamento vira "unknown" (nunca reenvia)', () => {
    const file = path.join(tmpDir(), 's.json');
    const s1 = new IdempotencyStore({ file, logger: quiet });
    s1.begin('r1', 'f'); s1.begin('r2', 'f'); s1.finish('r2', SendState.SENT, { messageId: 'm2' });
    const s2 = new IdempotencyStore({ file, logger: quiet });
    expect(s2.get('r1').state).toBe(SendState.UNKNOWN);
    expect(s2.get('r2')).toMatchObject({ state: SendState.SENT, messageId: 'm2' });
  });
  it('expira registros antigos', () => {
    let t = 0;
    const s = new IdempotencyStore({ ttlMs: 1000, now: () => t, logger: quiet });
    s.begin('r', 'f'); s.finish('r', SendState.SENT);
    t = 5000;
    expect(s.prune()).toBe(1);
    expect(s.get('r')).toBeNull();
  });
});

describe('outbox de eventos', () => {
  const okFetch = (log, status = 200) => async (url, init) => { log.push({ url, init }); return { status }; };

  it('dedup por eventId e entrega com assinatura', async () => {
    const log = [];
    const ob = new EventOutbox({ url: 'http://crm/api/whatsapp-connector/events', secret: SECRET, fetchImpl: okFetch(log), logger: quiet });
    ob.stop();
    const e = buildEvent('message.inbound', { waMessageId: 'X' });
    expect(ob.enqueue(e)).toBe(true);
    expect(ob.enqueue(e)).toBe(false);
    expect(await ob.flush()).toBe('delivered');
    expect(ob.size).toBe(0);
    const { init } = log[0];
    expect(verifySignature(SECRET, init.headers[SIGNATURE_HEADER], { method: 'POST', path: '/api/whatsapp-connector/events', body: init.body }).ok).toBe(true);
  });

  it('CRM fora do ar: mantém na fila, espera cada vez mais e entrega quando volta', async () => {
    let t = 0;
    let up = false;
    const ob = new EventOutbox({
      url: 'http://crm/e', secret: SECRET, now: () => t, random: () => 0.5, logger: quiet,
      fetchImpl: async () => { if (!up) { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; } return { status: 200 }; },
    });
    ob.stop();
    ob.enqueue(buildEvent('message.inbound', { waMessageId: 'A' }));
    expect(await ob.flush()).toBe('retry');
    const first = ob.nextAttemptAt;
    t = first; expect(await ob.flush()).toBe('retry');
    expect(ob.nextAttemptAt - t).toBeGreaterThan(first); // backoff cresce
    t = ob.nextAttemptAt; up = true;
    expect(await ob.flush()).toBe('delivered');
    expect(ob.size).toBe(0);
  });

  it('4xx do CRM vai para o descarte; reinício recupera a fila do disco', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'o.json');
    const dead = path.join(dir, 'dead.jsonl');
    const ob1 = new EventOutbox({ file, deadLetterFile: dead, url: 'http://crm/e', secret: SECRET, fetchImpl: async () => ({ status: 503 }), logger: quiet });
    ob1.stop();
    ob1.enqueue(buildEvent('message.inbound', { waMessageId: 'B' }));
    await ob1.flush();
    const ob2 = new EventOutbox({ file, deadLetterFile: dead, url: 'http://crm/e', secret: SECRET, fetchImpl: async () => ({ status: 401 }), logger: quiet });
    ob2.stop();
    expect(ob2.size).toBe(1); // sobreviveu ao "reinício"
    expect(await ob2.flush()).toBe('dead');
    expect(ob2.size).toBe(0);
    expect(fs.readFileSync(dead, 'utf8')).toContain('HTTP 401');
  });
});

describe('classificação do erro de envio', () => {
  it('só prova de não-envio vira falha definitiva', () => {
    expect(classifySendError(new Error('WhatsApp não está conectado'))).toBe(FailCode.NOT_CONNECTED);
    expect(classifySendError(new Error('Número inválido: x'))).toBe(FailCode.INVALID_NUMBER);
    expect(classifySendError(new Error('Número 55 não possui WhatsApp'))).toBe(FailCode.NO_WHATSAPP);
    expect(classifySendError(new Error('Protocol error: Target closed'))).toBeNull();
  });
});

describe('cenários com o simulador (HTTP real)', () => {
  let dir; let engine; let store; let srv; let client; let app;

  async function start({ sendTimeoutMs = 2_000 } = {}) {
    store = new IdempotencyStore({ file: path.join(dir, 'sends.json'), logger: quiet });
    app = createConnectorApp({ engine, store, secret: SECRET, sendTimeoutMs, sendMinIntervalMs: 0, logger: quiet });
    srv = await listen(app, { port: 0, host: '127.0.0.1' });
    client = createConnectorClient({ baseUrl: `http://127.0.0.1:${srv.port}`, secret: SECRET, timeoutMs: 3_000, sendTimeoutMs: 3_000, resolveDelayMs: 10 });
  }

  beforeEach(async () => { dir = tmpDir(); engine = createFakeEngine(); await start(); });
  afterEach(async () => { await srv?.close(); });

  it('sem assinatura ou com segredo errado → 401; health é aberto', async () => {
    const r1 = await fetch(`http://127.0.0.1:${srv.port}/v1/status`);
    expect(r1.status).toBe(401);
    const bad = createConnectorClient({ baseUrl: `http://127.0.0.1:${srv.port}`, secret: 'errado' });
    await expect(bad.getStatus()).rejects.toMatchObject({ status: 401 });
    expect((await fetch(`http://127.0.0.1:${srv.port}/v1/health`)).status).toBe(200);
  });

  it('envio normal e DUPLICADO: mesmo requestId → uma mensagem só, mesmo messageId', async () => {
    const a = await client.sendMessage({ requestId: 'whatsapp-send:1', phone: '5562999990000', text: 'oi' });
    const b = await client.sendMessage({ requestId: 'whatsapp-send:1', phone: '5562999990000', text: 'oi' });
    expect(a.success).toBe(true);
    expect(b).toMatchObject({ success: true, messageId: a.messageId, duplicate: true });
    expect(engine.state.sent).toHaveLength(1);
  });

  it('duplicado CONCORRENTE: o segundo espera e recebe o resultado do primeiro', async () => {
    const [a, b] = await Promise.all([
      client.sendMessage({ requestId: 'r-conc', phone: '5562999990000', text: 'oi' }),
      client.sendMessage({ requestId: 'r-conc', phone: '5562999990000', text: 'oi' }),
    ]);
    expect(a.messageId).toBe(b.messageId);
    expect(engine.state.sent).toHaveLength(1);
  });

  it('requestId reaproveitado com outro texto → recusado', async () => {
    await client.sendMessage({ requestId: 'r-x', phone: '5562999990000', text: 'um' });
    await expect(client.sendMessage({ requestId: 'r-x', phone: '5562999990000', text: 'dois' }))
      .rejects.toMatchObject({ code: FailCode.REQUEST_ID_REUSED, deliveryNotSent: true });
    expect(engine.state.sent).toHaveLength(1);
  });

  it('WhatsApp DESCONECTADO: falha definitiva (não saiu) e o mesmo requestId funciona quando volta', async () => {
    engine.setReady(false);
    await expect(client.sendMessage({ requestId: 'r-d', phone: '5562999990000', text: 'oi' }))
      .rejects.toMatchObject({ code: FailCode.NOT_CONNECTED, deliveryNotSent: true });
    expect((await client.getStatus()).ready).toBe(false);
    engine.setReady(true);
    expect((await client.sendMessage({ requestId: 'r-d', phone: '5562999990000', text: 'oi' })).success).toBe(true);
    expect(engine.state.sent).toHaveLength(1);
  });

  it('sem WhatsApp no número: falha definitiva e guardada (retry devolve a mesma falha, sem tentar de novo)', async () => {
    engine.failNext('no_whatsapp');
    await expect(client.sendMessage({ requestId: 'r-n', phone: '5562999990000', text: 'oi' })).rejects.toMatchObject({ code: FailCode.NO_WHATSAPP });
    await expect(client.sendMessage({ requestId: 'r-n', phone: '5562999990000', text: 'oi' })).rejects.toMatchObject({ deliveryNotSent: true });
    expect(engine.state.sent).toHaveLength(0);
  });

  it('erro NO MEIO do envio (Chrome caiu): resultado INCERTO, sem deliveryNotSent, e retry não reenvia', async () => {
    engine.failNext('network');
    const err = await client.sendMessage({ requestId: 'r-u', phone: '5562999990000', text: 'oi' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'UNCERTAIN', uncertain: true });
    expect(err.deliveryNotSent).toBeFalsy();
    const again = await client.sendMessage({ requestId: 'r-u', phone: '5562999990000', text: 'oi' }).catch((e) => e);
    expect(again.uncertain).toBe(true);
    expect(engine.state.sent.filter((s) => !s.ghost)).toHaveLength(0); // nada reenviado
  });

  it('TIMEOUT no envio: incerto; quando o Chrome conclui depois, a consulta passa a dizer "sent"', async () => {
    await srv.close();
    engine = createFakeEngine();
    await start({ sendTimeoutMs: 100 });
    engine.failNext('hang');
    const err = await client.sendMessage({ requestId: 'r-t', phone: '5562999990000', text: 'oi' }).catch((e) => e);
    expect(err.uncertain).toBe(true);
    engine.state.hangs.shift()(); // o envio pendurado termina
    await new Promise((r) => setTimeout(r, 20));
    expect(await client.getSendResult('r-t')).toMatchObject({ status: SendState.SENT });
    const ok = await client.sendMessage({ requestId: 'r-t', phone: '5562999990000', text: 'oi' });
    expect(ok.success).toBe(true);
    expect(engine.state.sent).toHaveLength(1);
  });

  it('REINÍCIO do conector no meio do envio: ao voltar, o envio fica "unknown" e não é repetido', async () => {
    store.begin('r-crash', 'qualquer'); // simula: reservou e o processo morreu antes de concluir
    await srv.close();
    await start(); // novo processo, mesmo disco
    const st = await client.getSendResult('r-crash');
    expect(st.status).toBe(SendState.UNKNOWN);
  });

  it('conector INDISPONÍVEL (porta fechada): erro "não chegou" — seguro tentar depois', async () => {
    const closedPort = srv.port;
    await srv.close();
    const dead = createConnectorClient({ baseUrl: `http://127.0.0.1:${closedPort}`, secret: SECRET, timeoutMs: 1_000 });
    await expect(dead.sendMessage({ requestId: 'r-off', phone: '5562999990000', text: 'oi' }))
      .rejects.toMatchObject({ unavailable: true, deliveryNotSent: true });
    srv = null;
  });

  it('leituras repassadas: atividade, varredura em lote, reconectar', async () => {
    const act = await client.getChatActivity('5562999990000');
    expect(act.contactAt).toBeInstanceOf(Date);
    const b = await client.readDeepScanBatch({ startIndex: 0, batchSize: 2, since: new Date(0) });
    expect(b).toMatchObject({ total: 3, nextIndex: 2 });
    await client.reconnect();
    expect(engine.state.reconnects).toBe(1);
    engine.setReady(false);
    await expect(client.getChatActivity('5562999990000')).rejects.toMatchObject({ status: 503 });
  });
});

describe('recebedor de eventos no CRM', () => {
  const path_ = '/api/whatsapp-connector/events';
  const mk = () => {
    const jobs = new Map();
    return { jobs, enqueue: async (id, evt) => { if (jobs.has(id)) return false; jobs.set(id, evt); return true; } };
  };
  const signed = (events, secret = SECRET) => {
    const rawBody = Buffer.from(JSON.stringify({ events }));
    return { rawBody, headers: { [SIGNATURE_HEADER]: signRequest(secret, { method: 'POST', path: path_, body: rawBody }) } };
  };

  it('aceita, deduplica (entrega repetida) e recusa assinatura inválida', async () => {
    const q = mk();
    const e1 = buildEvent('message.inbound', { waMessageId: 'M1', body: 'oi' });
    const r1 = await receiveConnectorEvents({ ...signed([e1, e1]), path: path_, secret: SECRET, enqueue: q.enqueue });
    expect(r1).toEqual({ status: 200, body: { accepted: 1, duplicates: 1, rejected: 0 } });
    const r2 = await receiveConnectorEvents({ ...signed([e1]), path: path_, secret: SECRET, enqueue: q.enqueue });
    expect(r2.body).toMatchObject({ accepted: 0, duplicates: 1 });
    const r3 = await receiveConnectorEvents({ ...signed([e1], 'errado'), path: path_, secret: SECRET, enqueue: q.enqueue });
    expect(r3.status).toBe(401);
    expect(q.jobs.size).toBe(1);
  });

  it('Redis fora: o erro sobe (rota responde 503 e o conector reentrega)', async () => {
    const e1 = buildEvent('message.inbound', { waMessageId: 'M2' });
    await expect(receiveConnectorEvents({ ...signed([e1]), path: path_, secret: SECRET, enqueue: async () => { throw new Error('ECONNREFUSED redis'); } }))
      .rejects.toThrow(/redis/);
  });

  it('ponta a ponta: CRM fora → outbox guarda → CRM volta → entrega uma vez só', async () => {
    const q = mk();
    let crmUp = false;
    const fetchImpl = async (url, init) => {
      if (!crmUp) { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
      const u = new URL(url);
      const r = await receiveConnectorEvents({ rawBody: Buffer.from(init.body), headers: init.headers, path: u.pathname, secret: SECRET, enqueue: q.enqueue, now: t });
      return { status: r.status };
    };
    let t = Date.now();
    const ob = new EventOutbox({ url: `http://crm${path_}`, secret: SECRET, fetchImpl, now: () => t, logger: quiet });
    ob.stop();
    const engine = createFakeEngine();
    engine.setSink((type, data) => ob.enqueue(buildEvent(type, data)));
    engine.emitInbound({ waMessageId: 'Z1', phone: '5562999990000', body: 'Vim pelo anúncio' });
    engine.emitInbound({ waMessageId: 'Z1', phone: '5562999990000', body: 'Vim pelo anúncio', source: 'catchup' }); // relida
    expect(ob.size).toBe(1);
    expect(await ob.flush()).toBe('retry');
    crmUp = true; t = ob.nextAttemptAt;
    expect(await ob.flush()).toBe('delivered');
    expect(q.jobs.size).toBe(1);
  });
});
