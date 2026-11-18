// services/whatsappConnector/eventsReceiver.js
//
// Recebe os eventos do conector (POST /api/whatsapp-connector/events). Só confere e enfileira:
// o processamento (regras de negócio) roda no crm-worker, fila "whatsapp-connector-events".
//   - assinatura HMAC sobre o corpo CRU (401 se não bater; o conector descarta como 4xx e loga);
//   - deduplicação por eventId: o id do job BullMQ é derivado dele, então o mesmo evento entregue duas
//     vezes vira um job só (enquanto o job for retido: 7 dias);
//   - Redis fora → 503: o conector guarda na fila em disco e tenta de novo.

import { SIGNATURE_HEADER, verifySignature, validateEvent, jobIdForEvent, secretsFromEnv } from './contract.js';

export const CONNECTOR_EVENTS_QUEUE = 'whatsapp-connector-events';
export const EVENT_JOB_OPTS = Object.freeze({
  attempts: 6,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 50_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
});

/**
 * Núcleo testável. `enqueue(jobId, evt)` deve devolver true quando criou o job e false quando já existia.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function receiveConnectorEvents({ rawBody, headers, method = 'POST', path, secret, enqueue, now = Date.now() }) {
  const auth = verifySignature(secret, headers?.[SIGNATURE_HEADER], { method, path, body: rawBody, now });
  if (!auth.ok) return { status: 401, body: { error: 'nao_autorizado', reason: auth.reason } };

  let payload;
  try { payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')); } catch { return { status: 400, body: { error: 'json_invalido' } }; }
  const events = Array.isArray(payload?.events) ? payload.events : null;
  if (!events) return { status: 400, body: { error: 'events_obrigatorio' } };
  if (events.length > 500) return { status: 413, body: { error: 'lote_grande_demais' } };

  let accepted = 0;
  let duplicates = 0;
  const rejected = [];
  for (const evt of events) {
    const errs = validateEvent(evt);
    if (errs.length) { rejected.push({ eventId: evt?.eventId || null, errs }); continue; }
    const created = await enqueue(jobIdForEvent(evt.eventId), evt); // erro do Redis sobe → 503
    if (created) accepted++; else duplicates++;
  }
  // Evento malformado não é reentregável (seria rejeitado sempre): aceita o lote e registra.
  if (rejected.length) console.warn('[WA-CONNECTOR] ⚠️ eventos malformados descartados:', JSON.stringify(rejected).slice(0, 500));
  return { status: 200, body: { accepted, duplicates, rejected: rejected.length } };
}

/** enqueue sobre uma Queue BullMQ: confere o job antes para contar duplicados (o add com o mesmo id já é no-op). */
export function bullEnqueuer(queue) {
  return async (jobId, evt) => {
    const existing = await queue.getJob(jobId);
    if (existing) return false;
    await queue.add(evt.type, evt, { ...EVENT_JOB_OPTS, jobId });
    return true;
  };
}

export const receiverSecret = () => secretsFromEnv(process.env.WA_CONNECTOR_SECRET);

export default { receiveConnectorEvents, bullEnqueuer, CONNECTOR_EVENTS_QUEUE, EVENT_JOB_OPTS };
