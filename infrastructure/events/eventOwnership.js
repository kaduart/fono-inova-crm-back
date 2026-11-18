// infrastructure/events/eventOwnership.js
/**
 * Posse de execução de eventos do Event Store.
 *
 * Cada execução de um evento recebe um token único (processingToken) e um
 * prazo de posse (leaseExpiresAt) renovado enquanto o processador roda.
 * Conclusão, falha e recuperação só gravam se o evento ainda estiver em
 * 'processing' com o MESMO token. Um worker que perdeu a posse (prazo vencido
 * e evento retomado por outro, ou recuperado pelo reaper) não altera mais o
 * registro.
 *
 * LIMITE: isto protege o REGISTRO no Event Store. Não desfaz nem impede efeitos
 * externos que o processador já tenha disparado (mensagens, notas fiscais,
 * cobranças). Esses efeitos precisam de idempotência própria. Ver
 * docs/EVENTSTORE_OWNERSHIP.md.
 */

import { randomUUID } from 'node:crypto';
import EventStore from '../../models/EventStore.js';

/**
 * Prazo de posse padrão: 60 s, renovado a cada 20 s.
 * Base: os workers BullMQ do CRM usam lockDuration/stalledInterval de 30 s.
 * O dobro tolera uma renovação perdida (event loop travado < 40 s) e deixa a
 * execução abandonada retomável logo depois da redistribuição de job travado
 * do BullMQ (30–60 s após a queda).
 */
export const DEFAULT_LEASE_MS = 60_000;

/**
 * Eventos 'processing' SEM token (gravados por código anterior a esta mudança)
 * só são retomados depois do mesmo limite do reaper legado: 15 min de createdAt.
 */
export const LEGACY_STUCK_MS = 15 * 60_000;

export function leaseMsFromEnv(env = process.env) {
  const raw = env.EVENT_LEASE_MS;
  if (raw === undefined || raw === '') return DEFAULT_LEASE_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 30 * 60_000) {
    throw new Error(`EVENT_LEASE_MS inválido: "${raw}" (use um inteiro entre 1000 e 1800000 ms)`);
  }
  return n;
}

export class OwnershipLostError extends Error {
  constructor(eventId, stage) {
    super(`Posse do evento ${eventId} perdida (${stage})`);
    this.name = 'OwnershipLostError';
    this.code = 'EVENT_OWNERSHIP_LOST';
    this.eventId = eventId;
    this.stage = stage;
  }
}

/** Erro retentável: outro worker tem posse viva do evento. */
export class EventBusyError extends Error {
  constructor(eventId) {
    super(`Evento ${eventId} em execução por outro worker (posse viva)`);
    this.name = 'EventBusyError';
    this.code = 'EVENT_BUSY';
    this.eventId = eventId;
    this.retryable = true;
  }
}

const LEASE_FIELDS = { processingToken: '', processingOwner: '', leaseExpiresAt: '' };

/** Filtro: o evento ainda é desta execução. */
export function ownedFilter(eventId, token) {
  return { eventId, status: 'processing', processingToken: token };
}

/** Filtro: nenhuma execução com posse viva (para escritas legadas sem token). */
export function notLiveOwnedFilter(now) {
  return { $or: [{ processingToken: { $exists: false } }, { leaseExpiresAt: { $lte: now } }] };
}

/**
 * Tenta tomar posse do evento.
 * @returns {Promise<{status:'claimed', token, leaseExpiresAt}
 *   | {status:'not_found'|'already_processed'|'dead_letter'|'busy'|'not_claimable', current?}>}
 */
export async function claimEvent(eventId, owner, { leaseMs = DEFAULT_LEASE_MS, now = new Date() } = {}) {
  const token = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const claimed = await EventStore.findOneAndUpdate(
    {
      eventId,
      $or: [
        { status: { $in: ['pending', 'failed'] } },
        // Execução abandonada: prazo vencido.
        { status: 'processing', leaseExpiresAt: { $lte: now } },
        // Execução legada sem token, presa pelo critério do reaper antigo.
        { status: 'processing', processingToken: { $exists: false }, createdAt: { $lt: new Date(now.getTime() - LEGACY_STUCK_MS) } }
      ]
    },
    {
      $set: {
        status: 'processing',
        processingToken: token,
        processingOwner: owner || 'unknown',
        processingStartedAt: now,
        leaseExpiresAt
      }
    },
    { new: true, projection: { eventId: 1, status: 1, attempts: 1 } }
  ).lean();
  if (claimed) return { status: 'claimed', token, leaseExpiresAt };

  const current = await EventStore.findOne({ eventId }, { eventId: 1, status: 1, processingToken: 1, leaseExpiresAt: 1, attempts: 1 }).lean();
  if (!current) return { status: 'not_found' };
  if (current.status === 'processed') return { status: 'already_processed', current };
  if (current.status === 'dead_letter') return { status: 'dead_letter', current };
  if (current.status === 'processing') return { status: 'busy', current };
  return { status: 'not_claimable', current };
}

/** Renova o prazo. false = a posse já não é desta execução. */
export async function renewLease(eventId, token, { leaseMs = DEFAULT_LEASE_MS, now = new Date() } = {}) {
  const r = await EventStore.updateOne(ownedFilter(eventId, token), { $set: { leaseExpiresAt: new Date(now.getTime() + leaseMs) } });
  return r.matchedCount === 1;
}

/** Conclui só se ainda for o dono. */
export async function completeOwned(eventId, token, workerName, { now = new Date() } = {}) {
  const r = await EventStore.updateOne(ownedFilter(eventId, token), {
    $set: { status: 'processed', processedAt: now, processedBy: workerName },
    $unset: LEASE_FIELDS
  });
  return r.matchedCount === 1;
}

/** Registra falha retentável só se ainda for o dono. Devolve o evento atualizado ou null. */
export async function failOwned(eventId, token, error) {
  return EventStore.findOneAndUpdate(ownedFilter(eventId, token), {
    $inc: { attempts: 1 },
    $set: { status: 'failed', error: { message: error?.message, stack: error?.stack, code: error?.code } },
    $unset: LEASE_FIELDS
  }, { new: true, projection: { eventId: 1, attempts: 1, status: 1 } }).lean();
}

/** Move para dead_letter só se ainda for o dono. */
export async function deadLetterOwned(eventId, token, error) {
  const r = await EventStore.updateOne(ownedFilter(eventId, token), {
    $set: { status: 'dead_letter', error: { message: error?.message, stack: error?.stack, code: error?.code } },
    $unset: LEASE_FIELDS
  });
  return r.matchedCount === 1;
}

/**
 * Mantém a posse viva enquanto o processador roda. Se a renovação descobrir
 * que a posse foi perdida, aborta o AbortSignal entregue ao processador.
 */
export function startLeaseKeeper(eventId, token, { leaseMs = DEFAULT_LEASE_MS, onLost, onError } = {}) {
  const controller = new AbortController();
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const ok = await renewLease(eventId, token, { leaseMs });
      if (!ok && !stopped) {
        stopped = true;
        clearInterval(timer);
        const err = new OwnershipLostError(eventId, 'renew');
        controller.abort(err);
        onLost?.(err);
      }
    } catch (e) {
      onError?.(e); // falha de banco: tenta de novo no próximo tique
    } finally {
      inFlight = false;
    }
  }, Math.max(250, Math.floor(leaseMs / 3)));
  timer.unref?.();
  return {
    signal: controller.signal,
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
