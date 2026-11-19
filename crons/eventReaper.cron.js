// crons/eventReaper.cron.js
/**
 * Reaper de eventos do Event Store travados em 'processing'
 *
 * Quando um worker morre ou perde conexão, o evento pode ficar preso em 'processing'
 * indefinidamente. Este cron detecta e move esses eventos de volta para 'pending'
 * (para retry) ou 'failed' (se já tentou muitas vezes).
 *
 * Com a posse de execução (infrastructure/events/eventOwnership.js) o critério
 * passa a ser o prazo de posse vencido; eventos sem posse registrada seguem o
 * critério antigo (createdAt > 15 min). Escrita condicional ao estado e à posse.
 * Ver docs/EVENTSTORE_OWNERSHIP.md.
 */

import EventStore from '../models/EventStore.js';
import { createContextLogger } from '../utils/logger.js';
import { sendAlert } from '../infrastructure/alerts/alertService.js';

const log = createContextLogger(null, 'event_reaper');
let isRunning = false;
let intervalId = null;
let warmupId = null;
let reaperLease = null;

const STUCK_THRESHOLD_MINUTES = 15;
const MAX_ATTEMPTS_FOR_RETRY = 3;

// Limite e justificativa em infrastructure/events/eventOwnership.js (fonte única).
import { MAX_RECOVERIES, legacyFenceFromEnv, legacyAbandonedFilter } from '../infrastructure/events/eventOwnership.js';
import mongoose from 'mongoose';
import {
    createReaperLease, liveReaperLeaseHolder, sharedLeaseModeFromEnv, reaperLeaseTtlFromEnv,
    ReaperLeaseLostError, markCrmNodeParticipant
} from '../infrastructure/events/reaperLease.js';
export { MAX_RECOVERIES };

/** Intervalo/aquecimento: padrão 5 min / 2 min; sobrescrevível só para o ambiente isolado. */
function msFromEnv(name, def, min) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} inválido: "${raw}"`);
    return n;
}

const LEGACY_MESSAGE = `Auto-recovered from stuck processing after ${STUCK_THRESHOLD_MINUTES}min`;
const LEASE_MESSAGE = 'Auto-recovered: processing lease expired';
const EXHAUSTED_MESSAGE = `Recovery limit reached (${MAX_RECOVERIES}); moved to dead_letter`;

/**
 * Elegível: em 'processing' e
 *  - com posse (leaseExpiresAt) vencida, ou
 *  - sem posse registrada (reivindicado por código antigo): só depois da cerca
 *    EVENT_LEGACY_FENCE_AT e com createdAt > 15 min (ver eventOwnership.js).
 *    Sem cerca, nunca: a execução antiga pode estar rodando.
 */
export function stuckFilter(now, legacyFence = legacyFenceFromEnv()) {
  const legacy = legacyAbandonedFilter(now, legacyFence);
  return {
    status: 'processing',
    $or: legacy ? [{ leaseExpiresAt: { $lte: now } }, legacy] : [{ leaseExpiresAt: { $lte: now } }]
  };
}

/** Eventos sem posse que esperam a cerca (só contagem, para aviso). */
export function legacyAwaitingFilter() {
  return { status: 'processing', processingToken: null, leaseExpiresAt: null };
}

/**
 * Condição exata sobre o valor observado: ausente → $exists:false;
 * null → $type:'null' (null sozinho também casaria ausente); senão $eq bruto.
 */
export function observed(event, field) {
  if (!(field in event) || event[field] === undefined) return { $exists: false };
  if (event[field] === null) return { $type: 'null' };
  return { $eq: event[field] };
}

/** Decisão para um evento observado. */
export function decide(event, maxRecoveries = MAX_RECOVERIES) {
  const recoveries = (Number(event.recoveryCount) || 0) + 1;
  if (recoveries >= maxRecoveries) return { to: 'dead_letter', recoveries, message: EXHAUSTED_MESSAGE, exhausted: true };
  const shouldRetry = event.attempts < MAX_ATTEMPTS_FOR_RETRY; // comparação JS preservada do legado
  return {
    to: shouldRetry ? 'pending' : 'failed',
    recoveries,
    message: event.leaseExpiresAt ? LEASE_MESSAGE : LEGACY_MESSAGE,
    exhausted: false
  };
}

/**
 * Recupera eventos presos em processing. Cada escrita é condicional ao estado
 * e à posse observados: se o worker concluir, falhar ou renovar a posse entre
 * a leitura e a escrita, nada é sobrescrito.
 */
export async function reapStuckEvents({ now = new Date(), alert = sendAlert, maxRecoveries = MAX_RECOVERIES, batchSize = 100, legacyFence = legacyFenceFromEnv(), lease = null } = {}) {
    const legacyActive = !!legacyAbandonedFilter(now, legacyFence);
    const legacyAwaiting = legacyActive ? 0 : await EventStore.countDocuments(legacyAwaitingFilter());
    if (legacyAwaiting > 0) {
        log.warn('reaper_legacy_awaiting_fence', `${legacyAwaiting} evento(s) em processing sem posse (código antigo) aguardando EVENT_LEGACY_FENCE_AT; não são retomados`, { legacyAwaiting });
    }
    const stuckEvents = await EventStore.find(stuckFilter(now, legacyFence), {
        eventId: 1, eventType: 1, status: 1, attempts: 1, createdAt: 1,
        processingToken: 1, leaseExpiresAt: 1, recoveryCount: 1
    }).sort({ createdAt: 1 }).limit(batchSize).lean();

    if (stuckEvents.length === 0) {
        return { reset: 0, failed: 0, deadLetter: 0, lostRace: 0, leaseLost: false, total: 0, legacyAwaiting };
    }

    log.warn('reaper_start', `Encontrados ${stuckEvents.length} evento(s) travados em processing`, {
        thresholdMinutes: STUCK_THRESHOLD_MINUTES
    });

    let resetCount = 0;
    let failCount = 0;
    let deadCount = 0;
    let lostRace = 0;
    let leaseLost = false;
    const details = [];

    for (const event of stuckEvents) {
        try {
            const d = decide(event, maxRecoveries);
            const filter = {
                eventId: event.eventId,
                status: 'processing',
                processingToken: observed(event, 'processingToken'),
                leaseExpiresAt: observed(event, 'leaseExpiresAt'),
                recoveryCount: observed(event, 'recoveryCount')
            };
            // Driver direto (sem cast do Mongoose): o filtro compara o valor
            // bruto observado, inclusive tipos inesperados gravados por código antigo.
            const update = {
                $set: { status: d.to, recoveryCount: d.recoveries, error: { message: d.message, code: d.exhausted ? 'RECOVERY_LIMIT_EXCEEDED' : 'RECOVERED_STUCK_PROCESSING' } },
                $unset: { processingToken: '', processingOwner: '', leaseExpiresAt: '' }
            };
            let r;
            if (lease) {
                // Escrita cercada: a recuperação e a confirmação da posse vão na
                // MESMA transação. Se outro dono (KAS ou outro Node) tomou a
                // posse, a transação não confirma e nada é gravado.
                const s = await mongoose.startSession();
                try {
                    await s.withTransaction(async () => {
                        await lease.fence(s);
                        r = await EventStore.collection.updateOne(filter, update, { session: s });
                    });
                } finally {
                    await s.endSession();
                }
            } else {
                r = await EventStore.collection.updateOne(filter, update);
            }

            if (r.matchedCount === 0) {
                lostRace++;
                log.info('reaper_lost_race', `Evento ${event.eventId} mudou antes da recuperação; nada gravado`, { eventId: event.eventId });
                details.push({ eventId: event.eventId, success: true, from: 'processing', to: null, lostRace: true });
                continue;
            }

            if (d.to === 'pending') resetCount++;
            else if (d.to === 'failed') failCount++;
            else deadCount++;

            if (d.exhausted) {
                log.error('reaper_dead_letter', `Evento ${event.eventId} atingiu ${maxRecoveries} recuperações → dead_letter`, {
                    eventId: event.eventId, eventType: event.eventType, recoveries: d.recoveries
                });
                await Promise.resolve(alert({
                    level: 'critical',
                    type: 'event_recovery_limit',
                    message: `Evento ${event.eventType} (${event.eventId}) abandonado ${d.recoveries} vezes; movido para dead_letter`,
                    details: { eventId: event.eventId, eventType: event.eventType, recoveries: d.recoveries }
                })).catch(e => log.error('reaper_alert_error', e.message, { eventId: event.eventId }));
            } else {
                log.info('reaper_recovered', `Evento ${event.eventId} → ${d.to}`, {
                    eventId: event.eventId, eventType: event.eventType, attempts: event.attempts, recoveries: d.recoveries
                });
            }

            details.push({ eventId: event.eventId, success: true, from: 'processing', to: d.to, attempts: event.attempts, recoveries: d.recoveries });
        } catch (error) {
            if (error instanceof ReaperLeaseLostError) {
                leaseLost = true;
                log.warn('reaper_lease_lost', `Posse do reaper perdida antes de recuperar ${event.eventId}; ciclo interrompido sem gravar`, { eventId: event.eventId });
                details.push({ eventId: event.eventId, success: false, leaseLost: true });
                break;
            }
            log.error('reaper_error', `Erro ao recuperar evento ${event.eventId}`, {
                error: error.message
            });
            details.push({
                eventId: event.eventId,
                success: false,
                error: error.message
            });
        }
    }

    return { reset: resetCount, failed: failCount, deadLetter: deadCount, lostRace, leaseLost, total: stuckEvents.length, legacyAwaiting, details };
}

async function runOnce() {
    if (isRunning) {
        console.log('[EventReaper] ⏭️ Já está rodando, pulando...');
        return;
    }

    isRunning = true;
    const startedAt = Date.now();
    console.log(`[EventReaper] 🔁 [${new Date().toISOString()}] Verificando eventos travados...`);

    try {
        // Posse compartilhada com o reaper da KAS (mesmo documento).
        //  - on: o Node disputa a posse; sem ela não reapera, e cada escrita é cercada.
        //  - off (padrão): só consulta; se a KAS tiver posse viva, o Node pula o ciclo.
        let lease = null;
        if (sharedLeaseModeFromEnv() === 'on') {
            reaperLease ??= createReaperLease({ ttlMs: reaperLeaseTtlFromEnv() });
            const acquired = await reaperLease.acquire();
            // Marca de participação: a KAS (-require-crm-node-lease) só age com ela fresca.
            await markCrmNodeParticipant(undefined, reaperLease.holder)
                .catch((e) => log.warn('reaper_participant_mark_failed', e.message));
            if (!acquired) {
                const h = await liveReaperLeaseHolder();
                log.info('reaper_not_leader', `Outro dono tem a posse do reaper (${h?.holder ?? 'desconhecido'}); ciclo pulado`, { holder: h?.holder });
                console.log(`[EventReaper] ⏭️ posse com ${h?.holder ?? 'outro dono'}; ciclo pulado`);
                return;
            }
            lease = reaperLease;
        } else {
            const h = await liveReaperLeaseHolder();
            if (h) {
                log.warn('reaper_skipped_foreign_lease', `Posse viva do reaper com ${h.holder}; o Node não reapera neste ciclo`, { holder: h.holder });
                console.log(`[EventReaper] ⏭️ posse viva com ${h.holder}; ciclo pulado`);
                return;
            }
        }
        const result = await reapStuckEvents({ lease });

        if (result.total > 0) {
            if (result.leaseLost) console.log('[EventReaper] ⛔ posse perdida no meio do ciclo; nada mais gravado');
            console.log(`[EventReaper] ✅ ${result.reset} resetados | ❌ ${result.failed} falhados | ☠️ ${result.deadLetter} dead_letter | ↩️ ${result.lostRace} sem efeito | Total: ${result.total} em ${Date.now() - startedAt}ms`);
        } else {
            console.log(`[EventReaper] ✅ nada a reaper em ${Date.now() - startedAt}ms`);
        }
    } catch (error) {
        console.error('[EventReaper] ❌ Erro:', error.message);
    } finally {
        isRunning = false;
    }
}

/**
 * Inicializa o cron de reaper de eventos
 */
export function initEventReaperCron() {
    if (intervalId) {
        console.log('[EventReaper] ⚠️ Já inicializado, ignorando');
        return { stop: () => clearInterval(intervalId) };
    }

    console.log('🔄 Inicializando Event Reaper Cron...');

    // Valida a configuração da posse antes de agendar (valor inválido derruba a subida).
    const leaseMode = sharedLeaseModeFromEnv();
    reaperLeaseTtlFromEnv();
    // Linha procurada na conferência antes da troca (docs/EVENTSTORE_OWNERSHIP.md §11).
    console.log(`[EventReaper] posse compartilhada: ${leaseMode} (EVENT_REAPER_SHARED_LEASE=${process.env.EVENT_REAPER_SHARED_LEASE ?? '(ausente)'})`);
    const intervalMs = msFromEnv('EVENT_REAPER_INTERVAL_MS', 5 * 60 * 1000, 500);
    const warmupMs = msFromEnv('EVENT_REAPER_WARMUP_MS', 2 * 60 * 1000, 0);

    // Roda a cada 5 minutos usando setInterval — evita overhead do node-cron/timezone
    intervalId = setInterval(runOnce, intervalMs);

    // Primeira execução após 2 minutos do startup
    warmupId = setTimeout(() => {
        console.log('[EventReaper] 🚀 Primeira execução (warmup)...');
        runOnce().catch(e => console.error('[EventReaper] Erro no warmup:', e.message));
    }, warmupMs);

    console.log('✅ Event Reaper Cron inicializado (a cada 5 min)');

    const stop = () => {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        if (warmupId) {
            clearTimeout(warmupId);
            warmupId = null;
        }
    };
    return {
        stop,
        /** Parada limpa: para o agendamento, espera o ciclo em curso e devolve a posse. */
        stopAndRelease: async () => {
            stop();
            for (let i = 0; isRunning && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
            if (reaperLease) await reaperLease.release().catch((e) => console.error('[EventReaper] Falha ao devolver a posse:', e.message));
        }
    };
}

export default { initEventReaperCron };

/** Um ciclo completo do cron (decisão on/off + recuperação), para os testes da posse. */
export { runOnce as runReaperCycle };
