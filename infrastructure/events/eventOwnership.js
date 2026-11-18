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
import { sendAlert } from '../alerts/alertService.js';

/**
 * Retomadas de posse abandonada antes do estado terminal dead_letter.
 * Conta tanto a retomada pelo reaper quanto a retomada direta por uma nova
 * execução (claimEvent sobre prazo vencido): as duas significam que uma
 * execução anterior morreu sem concluir nem falhar.
 *
 * Por que 3: por job, o BullMQ executa no máximo maxStalledCount + 1 vezes
 * antes de declarar "job stalled more than allowable limit". O maior
 * maxStalledCount do CRM é 2 (padrão 1), logo 3 execuções abandonadas
 * esgotam o que a própria fila permitiria. Erros comuns (exceção) não contam
 * aqui; eles seguem MAX_FAILED_ATTEMPTS (5) como antes.
 */
export const MAX_RECOVERIES = 3;
export const EXHAUSTED_CODE = 'RECOVERY_LIMIT_EXCEEDED';
export const EXHAUSTED_MESSAGE = `Recovery limit reached (${MAX_RECOVERIES}); moved to dead_letter`;

/**
 * Prazo de posse padrão: 60 s, renovado a cada 20 s.
 * Base: os workers BullMQ do CRM usam lockDuration/stalledInterval de 30 s.
 * O dobro tolera uma renovação perdida (event loop travado < 40 s) e deixa a
 * execução abandonada retomável logo depois da redistribuição de job travado
 * do BullMQ (30–60 s após a queda).
 */
export const DEFAULT_LEASE_MS = 60_000;

/**
 * Eventos 'processing' SEM token foram reivindicados por código anterior a
 * esta mudança, que não registra posse nem início. Não há como saber se a
 * execução antiga ainda roda. Por isso só são retomados quando:
 *  - EVENT_LEGACY_FENCE_AT está definida e já passou: o operador declara que,
 *    a partir desse instante, nenhum processo com o código antigo está de pé
 *    (deploy concluído em todos os serviços); e
 *  - o evento é mais antigo que o limite do reaper legado (15 min de createdAt).
 * Sem a cerca, esses eventos ficam intocados (o reaper só os conta e avisa).
 */
export const LEGACY_STUCK_MS = 15 * 60_000;

export function legacyFenceFromEnv(env = process.env) {
  const raw = env.EVENT_LEGACY_FENCE_AT;
  if (raw === undefined || raw.trim() === '') return null;
  const d = new Date(raw.trim());
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw.trim()) || Number.isNaN(d.getTime())) {
    throw new Error(`EVENT_LEGACY_FENCE_AT inválido: "${raw}" (use data ISO 8601 com fuso, ex.: 2026-11-20T03:00:00Z)`);
  }
  return d;
}

/** Filtro de evento legado (sem posse) que já pode ser retomado, ou null. */
export function legacyAbandonedFilter(now, fence) {
  if (!fence || now.getTime() < fence.getTime()) return null;
  return {
    // null ou ausente: sem posse registrada
    processingToken: null,
    leaseExpiresAt: null,
    createdAt: { $lt: new Date(Math.min(now.getTime() - LEGACY_STUCK_MS, fence.getTime())) }
  };
}

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
export async function claimEvent(eventId, owner, { leaseMs = DEFAULT_LEASE_MS, now = new Date(), maxRecoveries = MAX_RECOVERIES, alert = sendAlert, legacyFence = legacyFenceFromEnv() } = {}) {
  const token = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const claimSet = {
    status: 'processing',
    processingToken: token,
    processingOwner: owner || 'unknown',
    processingStartedAt: now,
    leaseExpiresAt
  };
  const projection = { eventId: 1, status: 1, attempts: 1, recoveryCount: 1 };

  // 1. Reivindicação normal.
  const claimed = await EventStore.findOneAndUpdate(
    { eventId, status: { $in: ['pending', 'failed'] } },
    { $set: claimSet },
    { new: true, projection }
  ).lean();
  if (claimed) return { status: 'claimed', token, leaseExpiresAt };

  // 2. Retomada de execução abandonada (conta como recuperação).
  const legacy = legacyAbandonedFilter(now, legacyFence);
  const abandoned = {
    status: 'processing',
    // Prazo vencido; ou execução legada sem posse, só depois da cerca.
    $or: legacy ? [{ leaseExpiresAt: { $lte: now } }, legacy] : [{ leaseExpiresAt: { $lte: now } }]
  };
  const retaken = await EventStore.findOneAndUpdate(
    { eventId, ...abandoned, $and: [{ $or: [{ recoveryCount: { $exists: false } }, { recoveryCount: null }, { recoveryCount: { $lt: maxRecoveries - 1 } }] }] },
    [{ $set: { ...claimSet, processingOwner: { $literal: claimSet.processingOwner }, recoveryCount: { $add: [{ $ifNull: ['$recoveryCount', 0] }, 1] } } }],
    { new: true, projection }
  ).lean();
  if (retaken) return { status: 'claimed', token, leaseExpiresAt, recovered: true, recoveryCount: retaken.recoveryCount };

  // 3. Abandonada pela última vez permitida: estado terminal + alerta.
  const exhausted = await EventStore.findOneAndUpdate(
    { eventId, ...abandoned, recoveryCount: { $gte: maxRecoveries - 1 } },
    [
      { $set: { status: 'dead_letter', recoveryCount: { $add: ['$recoveryCount', 1] }, error: { $literal: { message: EXHAUSTED_MESSAGE, code: EXHAUSTED_CODE } } } },
      { $unset: Object.keys(LEASE_FIELDS) }
    ],
    { new: true, projection: { ...projection, eventType: 1 } }
  ).lean();
  if (exhausted) {
    await Promise.resolve(alert({
      level: 'critical',
      type: 'event_recovery_limit',
      message: `Evento ${exhausted.eventType} (${eventId}) abandonado ${exhausted.recoveryCount} vezes; movido para dead_letter`,
      details: { eventId, eventType: exhausted.eventType, recoveries: exhausted.recoveryCount, stage: 'claim' }
    })).catch(() => {});
    return { status: 'dead_letter', current: exhausted, exhausted: true };
  }

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
