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

const STUCK_THRESHOLD_MINUTES = 15;
const MAX_ATTEMPTS_FOR_RETRY = 3;

// Limite e justificativa em infrastructure/events/eventOwnership.js (fonte única).
import { MAX_RECOVERIES } from '../infrastructure/events/eventOwnership.js';
export { MAX_RECOVERIES };

const LEGACY_MESSAGE = `Auto-recovered from stuck processing after ${STUCK_THRESHOLD_MINUTES}min`;
const LEASE_MESSAGE = 'Auto-recovered: processing lease expired';
const EXHAUSTED_MESSAGE = `Recovery limit reached (${MAX_RECOVERIES}); moved to dead_letter`;

/**
 * Elegível: em 'processing' e
 *  - com posse (leaseExpiresAt) vencida, ou
 *  - sem posse registrada (gravado por código antigo) e createdAt > 15 min (critério legado).
 */
export function stuckFilter(now) {
  const threshold = new Date(now.getTime() - STUCK_THRESHOLD_MINUTES * 60 * 1000);
  return {
    status: 'processing',
    $or: [
      { leaseExpiresAt: { $lte: now } },
      { leaseExpiresAt: { $exists: false }, createdAt: { $lt: threshold } }
    ]
  };
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
export async function reapStuckEvents({ now = new Date(), alert = sendAlert, maxRecoveries = MAX_RECOVERIES, batchSize = 100 } = {}) {
    const stuckEvents = await EventStore.find(stuckFilter(now), {
        eventId: 1, eventType: 1, status: 1, attempts: 1, createdAt: 1,
        processingToken: 1, leaseExpiresAt: 1, recoveryCount: 1
    }).sort({ createdAt: 1 }).limit(batchSize).lean();

    if (stuckEvents.length === 0) {
        return { reset: 0, failed: 0, deadLetter: 0, lostRace: 0, total: 0 };
    }

    log.warn('reaper_start', `Encontrados ${stuckEvents.length} evento(s) travados em processing`, {
        thresholdMinutes: STUCK_THRESHOLD_MINUTES
    });

    let resetCount = 0;
    let failCount = 0;
    let deadCount = 0;
    let lostRace = 0;
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
            const r = await EventStore.collection.updateOne(filter, {
                $set: { status: d.to, recoveryCount: d.recoveries, error: { message: d.message, code: d.exhausted ? 'RECOVERY_LIMIT_EXCEEDED' : 'RECOVERED_STUCK_PROCESSING' } },
                $unset: { processingToken: '', processingOwner: '', leaseExpiresAt: '' }
            });

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

    return { reset: resetCount, failed: failCount, deadLetter: deadCount, lostRace, total: stuckEvents.length, details };
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
        const result = await reapStuckEvents();

        if (result.total > 0) {
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

    // Roda a cada 5 minutos usando setInterval — evita overhead do node-cron/timezone
    intervalId = setInterval(runOnce, 5 * 60 * 1000);

    // Primeira execução após 2 minutos do startup
    setTimeout(() => {
        console.log('[EventReaper] 🚀 Primeira execução (warmup)...');
        runOnce().catch(e => console.error('[EventReaper] Erro no warmup:', e.message));
    }, 2 * 60 * 1000);

    console.log('✅ Event Reaper Cron inicializado (a cada 5 min)');

    return {
        stop: () => {
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
            }
        }
    };
}

export default { initEventReaperCron };
