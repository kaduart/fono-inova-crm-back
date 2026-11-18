// services/whatsappConnector/client.js
//
// Cliente HTTP do CRM para o conector WhatsApp externo (18/11/2026).
// Toda chamada é assinada (HMAC) e tem tempo-limite. Envio de mensagem é idempotente por requestId e o
// resultado é sempre explícito:
//   - sucesso                           → { success: true, messageId }
//   - falha que PROVA que nada saiu     → lança erro com err.deliveryNotSent = true (pode tentar de novo)
//   - resultado incerto (timeout, queda no meio, 5xx, "unknown")
//                                        → consulta GET /v1/messages/:requestId; se continuar incerto,
//                                          lança erro com err.uncertain = true e SEM deliveryNotSent
//                                          (o deliveryGuard grava "unknown" e nada reenvia sozinho).

import {
  SIGNATURE_HEADER, SendState, FailCode, signRequest, secretsFromEnv,
} from './contract.js';

export class ConnectorError extends Error {
  constructor(message, { status = 0, code = null, deliveryNotSent = false, uncertain = false, unavailable = false, body = null } = {}) {
    super(message);
    this.name = 'ConnectorError';
    Object.assign(this, { status, code, deliveryNotSent, uncertain, unavailable, body });
  }
}

// Erros de rede que provam que a requisição NÃO chegou ao conector (nada pode ter sido enviado).
const NOT_DELIVERED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const netCode = (err) => err?.cause?.code || err?.code || null;

export function createConnectorClient({
  baseUrl = process.env.WA_CONNECTOR_URL,
  secret = secretsFromEnv(process.env.WA_CONNECTOR_SECRET),
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.WA_CONNECTOR_TIMEOUT_MS || 15_000),
  sendTimeoutMs = Number(process.env.WA_CONNECTOR_SEND_TIMEOUT_MS || 100_000),
  resolveAttempts = 3,
  resolveDelayMs = 2_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!baseUrl) throw new Error('WA_CONNECTOR_URL não configurado');
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, body, { timeout = timeoutMs } = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(raw ? { 'content-type': 'application/json' } : {}),
          [SIGNATURE_HEADER]: signRequest(secret, { method, path, body: raw, now: now() }),
        },
        ...(raw ? { body: raw } : {}),
        signal: ctrl.signal,
      });
    } catch (err) {
      const code = netCode(err);
      if (err?.name === 'AbortError') throw new ConnectorError(`conector: tempo esgotado em ${method} ${path} (${timeout} ms)`, { code: 'TIMEOUT', uncertain: true });
      if (NOT_DELIVERED_CODES.has(code)) throw new ConnectorError(`conector indisponível (${code})`, { code, unavailable: true, deliveryNotSent: true });
      throw new ConnectorError(`conector: falha de rede em ${method} ${path} (${code || err?.message})`, { code: code || 'NETWORK', uncertain: true });
    } finally {
      clearTimeout(t);
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  }

  async function call(method, path, body, opts) {
    const { status, data } = await request(method, path, body, opts);
    if (status >= 200 && status < 300) return data;
    throw new ConnectorError(data?.error || `conector respondeu HTTP ${status}`, {
      status, code: data?.code || null, body: data,
      // 503 do conector = WhatsApp desconectado: a leitura/ação não aconteceu.
      deliveryNotSent: status === 503 || (status >= 400 && status < 500),
    });
  }

  /** Consulta o resultado guardado de um envio. null quando o conector não conhece o requestId. */
  async function getSendResult(requestId) {
    const { status, data } = await request('GET', `/v1/messages/${encodeURIComponent(requestId)}`);
    if (status === 404) return null;
    if (status !== 200) throw new ConnectorError(`conector respondeu HTTP ${status}`, { status, uncertain: true });
    return data;
  }

  /**
   * Resolve um envio incerto: lê o estado até `resolveAttempts` vezes.
   * 'sent' → sucesso; 'failed' → falha definitiva; 404 → a requisição nunca chegou (não saiu);
   * 'in_progress'/'unknown'/erro → continua incerto.
   */
  async function resolveSend(requestId, firstError) {
    let last = firstError;
    for (let i = 0; i < resolveAttempts; i++) {
      if (i) await sleep(resolveDelayMs);
      try {
        const r = await getSendResult(requestId);
        if (r === null) {
          throw new ConnectorError('o conector não recebeu o envio (requestId desconhecido)', { code: 'NOT_RECEIVED', deliveryNotSent: true });
        }
        if (r.status === SendState.SENT) return { success: true, messageId: r.messageId || null, resolvedAfterUncertain: true };
        if (r.status === SendState.FAILED) {
          throw new ConnectorError(r.error || `envio recusado (${r.code})`, { code: r.code, deliveryNotSent: true });
        }
        if (r.status === SendState.UNKNOWN) break; // o conector também não sabe: não adianta insistir
        last = new ConnectorError(`envio ainda em andamento no conector`, { code: 'IN_PROGRESS', uncertain: true });
      } catch (err) {
        if (err?.deliveryNotSent) throw err;
        last = err;
      }
    }
    throw new ConnectorError(`resultado do envio incerto (${last?.message || 'sem resposta'}) — não reenviar automaticamente`, {
      code: 'UNCERTAIN', uncertain: true, body: { requestId },
    });
  }

  /**
   * Envia texto (kind 'text') ou o lembrete de presença com enquete (kind 'attendance_confirmation').
   * O MESMO requestId nunca gera duas mensagens: use um id estável por envio lógico (ex.: id do job).
   */
  async function sendMessage({ requestId, phone, text, kind = 'text', appointmentId = null }) {
    if (!requestId) throw new ConnectorError('requestId obrigatório', { code: FailCode.BAD_REQUEST, deliveryNotSent: true });
    let res;
    try {
      res = await request('POST', '/v1/messages', { requestId, phone, text, kind, appointmentId }, { timeout: sendTimeoutMs });
    } catch (err) {
      if (err?.deliveryNotSent) throw err; // nem chegou ao conector
      return resolveSend(requestId, err);
    }
    const { status, data } = res;
    if (status === 200 && data?.status === SendState.SENT) return { success: true, messageId: data.messageId || null, duplicate: Boolean(data.duplicate) };
    if (data?.status === SendState.FAILED || (status >= 400 && status < 500 && status !== 409 && status !== 408)) {
      throw new ConnectorError(data?.error || `envio recusado (HTTP ${status})`, { status, code: data?.code || null, deliveryNotSent: true, body: data });
    }
    if (status === 503) throw new ConnectorError(data?.error || 'WhatsApp desconectado no conector', { status, code: FailCode.NOT_CONNECTED, deliveryNotSent: true });
    // 409 in_progress, 200 unknown, 5xx: pergunta o resultado.
    return resolveSend(requestId, new ConnectorError(`resposta ${status}/${data?.status || '-'}`, { status, uncertain: true }));
  }

  return {
    baseUrl: base,
    request,
    getSendResult,
    sendMessage,
    getStatus: () => call('GET', '/v1/status'),
    getChatActivity: async (phone) => {
      const r = await call('POST', '/v1/chats/activity', { phone }, { timeout: 60_000 });
      return { ...r, clinicAt: r?.clinicAt ? new Date(r.clinicAt) : null, contactAt: r?.contactAt ? new Date(r.contactAt) : null };
    },
    readChatActivity: async ({ onlyTails = null } = {}) => {
      const r = await call('POST', '/v1/chats/activity-bulk', { onlyTails: onlyTails ? [...onlyTails] : null }, { timeout: 10 * 60_000 });
      return { ...r, rows: (r?.rows || []).map((x) => ({ ...x, clinicAt: x.clinicAt ? new Date(x.clinicAt) : null, contactAt: x.contactAt ? new Date(x.contactAt) : null })) };
    },
    readDeepScanBatch: (p) => call('POST', '/v1/scans/deep-batch', { ...p, since: p?.since ? new Date(p.since).toISOString() : undefined }, { timeout: 10 * 60_000 }),
    resolveLids: async (lids) => (await call('POST', '/v1/contacts/resolve-lids', { lids }, { timeout: 120_000 }))?.results || [],
    readPollVotes: async (messageIds) => (await call('POST', '/v1/polls/votes', { messageIds }, { timeout: 120_000 }))?.results || [],
    reconnect: () => call('POST', '/v1/session/reconnect', {}),
    clearSession: () => call('POST', '/v1/session/clear', {}),
  };
}

let singleton = null;
/** Cliente com as envs do processo (WA_CONNECTOR_URL, WA_CONNECTOR_SECRET). */
export function getConnectorClient() {
  if (!singleton) singleton = createConnectorClient();
  return singleton;
}

export const isExternalMode = (env = process.env) => env.WHATSAPP_CONNECTOR_MODE === 'external';

export default { createConnectorClient, getConnectorClient, isExternalMode, ConnectorError };
