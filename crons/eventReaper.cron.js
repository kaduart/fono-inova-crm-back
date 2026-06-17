// crons/eventReaper.cron.js
/**
 * Reaper de eventos do Event Store travados em 'processing'
 *
 * Quando um worker morre ou perde conexão, o evento pode ficar preso em 'processing'
 * indefinidamente. Este cron detecta e move esses eventos de volta para 'pending'
 * (para retry) ou 'failed' (se já tentou muitas vezes).
 */

import EventStore from '../models/EventStore.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger(null, 'event_reaper');
let isRunning = false;
let intervalId = null;

const STUCK_THRESHOLD_MINUTES = 15;
const MAX_ATTEMPTS_FOR_RETRY = 3;

/**
 * Recupera eventos presos em processing
 */
async function reapStuckEvents() {
    const threshold = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);

    // Eventos em processing há mais de N minutos
    const stuckEvents = await EventStore.find({
        status: 'processing',
        createdAt: { $lt: threshold }
    }).sort({ createdAt: 1 }).limit(100).lean();

    if (stuckEvents.length === 0) {
        return { reset: 0, failed: 0, total: 0 };
    }

    log.warn('reaper_start', `Encontrados ${stuckEvents.length} evento(s) travados em processing`, {
        thresholdMinutes: STUCK_THRESHOLD_MINUTES
    });

    let resetCount = 0;
    let failCount = 0;
    const details = [];

    for (const event of stuckEvents) {
        try {
            const shouldRetry = event.attempts < MAX_ATTEMPTS_FOR_RETRY;
            const newStatus = shouldRetry ? 'pending' : 'failed';

            await EventStore.updateOne(
                { eventId: event.eventId },
                {
                    $set: {
                        status: newStatus,
                        error: {
                            message: `Auto-recovered from stuck processing after ${STUCK_THRESHOLD_MINUTES}min`,
                            recoveredAt: new Date(),
                            recoveredBy: 'eventReaper'
                        }
                    }
                }
            );

            if (shouldRetry) {
                resetCount++;
                log.info('reaper_reset', `Evento ${event.eventId} resetado para pending`, {
                    eventId: event.eventId,
                    eventType: event.eventType,
                    attempts: event.attempts
                });
            } else {
                failCount++;
                log.warn('reaper_failed', `Evento ${event.eventId} movido para failed (muitas tentativas)`, {
                    eventId: event.eventId,
                    eventType: event.eventType,
                    attempts: event.attempts
                });
            }

            details.push({
                eventId: event.eventId,
                success: true,
                from: 'processing',
                to: newStatus,
                attempts: event.attempts
            });
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

    return { reset: resetCount, failed: failCount, total: stuckEvents.length, details };
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
            console.log(`[EventReaper] ✅ ${result.reset} resetados | ❌ ${result.failed} falhados | Total: ${result.total} em ${Date.now() - startedAt}ms`);
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
