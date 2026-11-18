// whatsapp-connector/app.js
//
// API HTTP do conector WhatsApp (18/11/2026). Só mantém a sessão e o navegador; nenhuma regra de negócio.
// `engine` é injetado: em produção, as funções do whatsappWebJsService (com WA_ENGINE_ROLE=connector);
// nos testes, um simulador. Contrato: docs/WHATSAPP_CONECTOR_EXTERNO.md e services/whatsappConnector/contract.js.

import http from 'http';
import {
  SIGNATURE_HEADER, SendState, FailCode, verifySignature,
} from '../services/whatsappConnector/contract.js';
import { payloadFingerprint } from './idempotencyStore.js';

const MAX_BODY = 1024 * 1024;

/** Classifica o erro do envio: só devolve FailCode quando o erro PROVA que nada saiu. */
export function classifySendError(err) {
  const msg = String(err?.message || err || '');
  if (/não está conectado/i.test(msg)) return FailCode.NOT_CONNECTED;
  if (/Número inválido|invalid (phone|number)/i.test(msg)) return FailCode.INVALID_NUMBER;
  if (/não possui WhatsApp/i.test(msg)) return FailCode.NO_WHATSAPP;
  return null; // qualquer outra coisa: pode ter saído
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('corpo grande demais'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const withTimeout = (p, ms, label) => {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label}: tempo esgotado (${ms} ms)`), { timeout: true })), ms); }),
  ]);
};

/**
 * @param {{ engine: object, store: import('./idempotencyStore.js').IdempotencyStore, secret: string|string[],
 *           outbox?: import('./eventOutbox.js').EventOutbox, sendTimeoutMs?: number, readTimeoutMs?: number,
 *           sendMinIntervalMs?: number, now?: () => number, logger?: object }} deps
 */
export function createConnectorApp({
  engine, store, secret, outbox = null,
  sendTimeoutMs = 90_000, readTimeoutMs = 120_000, sendMinIntervalMs = 1_000,
  now = () => Date.now(), logger = console,
}) {
  let sendChain = Promise.resolve();
  let lastSendAt = 0;

  // Um envio por vez (o WhatsApp Web não aguenta paralelo), com intervalo mínimo entre eles.
  const serialize = (fn) => {
    const run = sendChain.then(async () => {
      const wait = lastSendAt + sendMinIntervalMs - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { lastSendAt = now(); }
    });
    sendChain = run.catch(() => {});
    return run;
  };

  async function doSend(body) {
    const { requestId, phone, text, kind = 'text', appointmentId = null } = body || {};
    if (!requestId || typeof requestId !== 'string' || requestId.length > 200 || !phone || typeof text !== 'string' || !text.trim()) {
      return [400, { status: SendState.FAILED, code: FailCode.BAD_REQUEST, error: 'requestId, phone e text são obrigatórios' }];
    }
    const fingerprint = payloadFingerprint({ phone: String(phone), text, kind, appointmentId });
    const r = store.begin(requestId, fingerprint);
    if (r.conflict) return [409, { status: SendState.FAILED, code: FailCode.REQUEST_ID_REUSED, error: 'requestId já usado com outro conteúdo' }];
    if (!r.reserved) {
      const rec = r.record;
      return [rec.state === SendState.IN_PROGRESS ? 409 : 200, { status: rec.state, messageId: rec.messageId || null, code: rec.code || null, duplicate: true }];
    }

    const opts = { attendanceConfirmation: kind === 'attendance_confirmation', appointmentId };
    const attempt = serialize(() => engine.sendMessage(String(phone), text, opts));
    try {
      const result = await withTimeout(attempt, sendTimeoutMs, 'envio');
      store.finish(requestId, SendState.SENT, { messageId: result?.messageId || null });
      return [200, { status: SendState.SENT, messageId: result?.messageId || null }];
    } catch (err) {
      if (err?.timeout) {
        // Ainda pode concluir: quando concluir, o registro é atualizado e o CRM lê em GET /v1/messages/:id.
        store.finish(requestId, SendState.UNKNOWN, { error: err.message });
        attempt.then(
          (result) => store.finish(requestId, SendState.SENT, { messageId: result?.messageId || null, error: null, lateResolved: true }),
          (lateErr) => store.finish(requestId, SendState.UNKNOWN, { error: lateErr?.message || String(lateErr) }),
        );
        logger.warn?.(`[Connector] ❓ envio ${requestId} sem resposta em ${sendTimeoutMs} ms — incerto`);
        return [200, { status: SendState.UNKNOWN, error: err.message }];
      }
      const code = classifySendError(err);
      if (code === FailCode.NOT_CONNECTED) {
        store.release(requestId); // nada saiu e nada ficou preso: o CRM pode tentar de novo com o mesmo id
        return [503, { status: SendState.FAILED, code, error: err.message }];
      }
      if (code) {
        store.finish(requestId, SendState.FAILED, { code, error: err.message });
        return [422, { status: SendState.FAILED, code, error: err.message }];
      }
      store.finish(requestId, SendState.UNKNOWN, { error: err?.message || String(err) });
      logger.warn?.(`[Connector] ❓ envio ${requestId} falhou no meio (${err?.message}) — incerto, não repetir sozinho`);
      return [200, { status: SendState.UNKNOWN, error: err?.message || String(err) }];
    }
  }

  const routes = {
    'GET /v1/status': async () => {
      const st = await engine.getStatus();
      return [200, { ...st, outbox: outbox ? { pending: outbox.size, ...outbox.stats } : null, pid: process.pid, uptime: process.uptime() }];
    },
    'POST /v1/messages': (b) => doSend(b),
    'POST /v1/chats/activity': async (b) => [200, await withTimeout(engine.getChatActivity(b.phone), readTimeoutMs, 'atividade')],
    'POST /v1/chats/activity-bulk': async (b) => [200, await withTimeout(engine.readChatActivity({ onlyTails: b.onlyTails ? new Set(b.onlyTails) : null }), readTimeoutMs, 'atividade')],
    'POST /v1/scans/deep-batch': async (b) => [200, await withTimeout(engine.readDeepScanBatch({
      startIndex: Number(b.startIndex) || 0,
      batchSize: Math.min(Number(b.batchSize) || 20, 50),
      since: b.since ? new Date(b.since) : undefined,
      maxLoadsPerChat: Math.min(Number(b.maxLoadsPerChat) || 80, 200),
    }), readTimeoutMs * 3, 'varredura')],
    'POST /v1/contacts/resolve-lids': async (b) => [200, { results: await withTimeout(engine.resolveLidsToPhones(Array.isArray(b.lids) ? b.lids : []), readTimeoutMs, 'lids') }],
    'POST /v1/polls/votes': async (b) => [200, { results: await withTimeout(engine.readPollVotes(Array.isArray(b.messageIds) ? b.messageIds : []), readTimeoutMs, 'votos') }],
    'POST /v1/session/reconnect': async () => [202, await engine.reconnect()],
    'POST /v1/session/clear': async () => [202, await engine.clearSession()],
  };

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true });
      const raw = await readBody(req);
      const auth = verifySignature(secret, req.headers[SIGNATURE_HEADER], { method: req.method, path: url.pathname + url.search, body: raw, now: now() });
      if (!auth.ok) return send(res, 401, { error: 'nao_autorizado', reason: auth.reason });

      const m = /^\/v1\/messages\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const rec = store.get(decodeURIComponent(m[1]));
        if (!rec) return send(res, 404, { status: 'not_found' });
        return send(res, 200, { status: rec.state, messageId: rec.messageId || null, code: rec.code || null, error: rec.error || null, updatedAt: rec.updatedAt });
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: 'rota_inexistente' });
      let body = {};
      if (raw.length) {
        try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'json_invalido' }); }
      }
      const [status, out] = await route(body);
      return send(res, status, out);
    } catch (err) {
      const status = err?.status || (/não está conectado/i.test(err?.message) ? 503 : err?.timeout ? 504 : 500);
      if (status >= 500) logger.error?.(`[Connector] ❌ ${req.method} ${url.pathname}:`, err?.message);
      return send(res, status, { error: err?.message || 'erro' });
    }
  };
}

/** Sobe o servidor HTTP. Devolve { server, port, close() }. */
export function listen(handler, { port = 0, host = '0.0.0.0' } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.keepAliveTimeout = 65_000;
    server.listen(port, host, () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

export default { createConnectorApp, classifySendError, listen };
