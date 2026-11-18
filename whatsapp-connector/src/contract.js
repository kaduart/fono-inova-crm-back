// CÓPIA do contrato: o original é services/whatsappConnector/contract.js no CRM. Os dois projetos não
// importam um do outro; o teste do CRM tests/unit/whatsappConnector.separation.test.js exige que o corpo
// abaixo da linha de cabeçalho seja idêntico nos dois.
//
// Contrato entre o CRM e o conector WhatsApp externo (18/11/2026).
// Sem dependências além do Node. Documento: docs/WHATSAPP_CONECTOR_EXTERNO.md.
//
// Autenticação: HMAC-SHA256 com segredo compartilhado, nos dois sentidos.
//   Header  X-WA-Signature: t=<epoch seg>,v1=<hex>
//   Assina  `${t}.${METHOD}.${path}.${sha256hex(corpo cru)}`
//   Janela  ±300 s (replay fora da janela é recusado; dentro dela, requestId/eventId deduplicam).
//   Rotação: aceita uma lista de segredos (o primeiro assina).

import crypto from 'crypto';

export const CONTRACT_VERSION = 1;
export const SIGNATURE_HEADER = 'x-wa-signature';
export const SIGNATURE_TOLERANCE_SEC = 300;

export const EventType = Object.freeze({
  MESSAGE_INBOUND: 'message.inbound',
  MESSAGE_OUTBOUND: 'message.outbound',
  POLL_VOTE: 'poll.vote',
});

/** Estados de um envio no conector (GET /v1/messages/:requestId). */
export const SendState = Object.freeze({
  IN_PROGRESS: 'in_progress', // tentando agora
  SENT: 'sent',               // WhatsApp confirmou; messageId pode vir
  FAILED: 'failed',           // NÃO saiu (prova): número inválido, sem WhatsApp, desconectado antes de tentar
  UNKNOWN: 'unknown',         // pode ter saído (erro/timeout no meio, ou conector caiu durante o envio)
});

/** Códigos de falha definitiva (a mensagem comprovadamente não saiu). */
export const FailCode = Object.freeze({
  NOT_CONNECTED: 'NOT_CONNECTED',
  INVALID_NUMBER: 'INVALID_NUMBER',
  NO_WHATSAPP: 'NO_WHATSAPP',
  BAD_REQUEST: 'BAD_REQUEST',
  REQUEST_ID_REUSED: 'REQUEST_ID_REUSED',
});

export const sha256hex = (buf) => crypto.createHash('sha256').update(buf ?? '').digest('hex');

const asList = (secret) => (Array.isArray(secret) ? secret : String(secret || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

/** Lê a lista de segredos de uma env (vírgula separa; o primeiro assina). */
export function secretsFromEnv(value) {
  return asList(value);
}

function mac(secret, t, method, path, body) {
  return crypto.createHmac('sha256', secret)
    .update(`${t}.${String(method).toUpperCase()}.${path}.${sha256hex(body ?? '')}`)
    .digest('hex');
}

/** Valor do header de assinatura para uma requisição. `path` sem host, com query (ex.: /v1/status). */
export function signRequest(secret, { method, path, body = '', now = Date.now() }) {
  const [first] = asList(secret);
  if (!first) throw new Error('segredo do conector não configurado');
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${mac(first, t, method, path, body)}`;
}

/**
 * Confere a assinatura. Devolve { ok: true } ou { ok: false, reason }.
 * Comparação em tempo constante; aceita qualquer segredo da lista (rotação).
 */
export function verifySignature(secret, header, { method, path, body = '', now = Date.now(), toleranceSec = SIGNATURE_TOLERANCE_SEC }) {
  const secrets = asList(secret);
  if (!secrets.length) return { ok: false, reason: 'segredo_nao_configurado' };
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(String(header || '').trim());
  if (!m) return { ok: false, reason: 'assinatura_ausente' };
  const t = Number(m[1]);
  if (Math.abs(Math.floor(now / 1000) - t) > toleranceSec) return { ok: false, reason: 'fora_da_janela' };
  const got = Buffer.from(m[2], 'hex');
  for (const s of secrets) {
    const want = Buffer.from(mac(s, t, method, path, body), 'hex');
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return { ok: true };
  }
  return { ok: false, reason: 'assinatura_invalida' };
}

/**
 * Id ESTÁVEL do evento: a mesma mensagem relida (catch-up, reinício, reenvio do outbox) gera o mesmo id,
 * e o CRM descarta a repetição. Sem id do WhatsApp, cai num hash do conteúdo.
 */
export function eventIdFor(type, data = {}) {
  switch (type) {
    case EventType.MESSAGE_INBOUND:
      if (data.waMessageId) return `in:${data.waMessageId}`;
      break;
    case EventType.MESSAGE_OUTBOUND:
      if (data.waMessageId) return `out:${data.waMessageId}`;
      break;
    case EventType.POLL_VOTE:
      return `vote:${sha256hex(JSON.stringify([data.pollMessageId, data.voterPhone, data.optionName, data.respondedAtMs])).slice(0, 40)}`;
    default:
      break;
  }
  return `${type}:${sha256hex(JSON.stringify(data)).slice(0, 40)}`;
}

/** Envelope de evento conector → CRM. */
export function buildEvent(type, data, { connectorId = 'main', now = Date.now() } = {}) {
  return { v: CONTRACT_VERSION, eventId: eventIdFor(type, data), type, connectorId, occurredAt: new Date(now).toISOString(), data };
}

/** Valida o envelope recebido. Devolve a lista de problemas (vazia = ok). */
export function validateEvent(evt) {
  const errs = [];
  if (!evt || typeof evt !== 'object') return ['evento_invalido'];
  if (typeof evt.eventId !== 'string' || !evt.eventId || evt.eventId.length > 200) errs.push('eventId');
  if (typeof evt.type !== 'string' || !evt.type) errs.push('type');
  if (!evt.data || typeof evt.data !== 'object') errs.push('data');
  return errs;
}

/** Id de job BullMQ a partir do eventId (BullMQ não aceita ':' em id customizado). */
export const jobIdForEvent = (eventId) => `wa-evt-${sha256hex(String(eventId)).slice(0, 40)}`;

export default {
  CONTRACT_VERSION, SIGNATURE_HEADER, EventType, SendState, FailCode,
  signRequest, verifySignature, secretsFromEnv, eventIdFor, buildEvent, validateEvent, jobIdForEvent, sha256hex,
};
