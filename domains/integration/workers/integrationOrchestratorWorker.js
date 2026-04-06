/**
 * ============================================================================
 * INTEGRATION ORCHESTRATOR WORKER - BullMQ
 * ============================================================================
 *
 * Consome eventos da fila 'integration-orchestrator' e os traduz/roteia
 * para os domínios corretos via publishEvent.
 *
 * NÃO contém regra de negócio.
 * Responsabilidades:
 *  - Receber eventos de qualquer domínio
 *  - Chamar o adapter adequado (tradução de payload)
 *  - Publicar o evento resultante na fila do domínio destino
 *  - Ignorar eventos sem adapter registrado (warn, não throw)
 * ============================================================================
 */

import { Worker } from 'bullmq';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import {
    mapAppointmentCompleted,
    mapSessionCompleted,
} from '../adapters/clinicalToBilling.adapter.js';
import { mapPaymentCompleted } from '../adapters/billingToWhatsApp.adapter.js';

// =============================================================================
// CONFIGURAÇÃO
// =============================================================================

const QUEUE_NAME = 'integration-orchestrator';

const WORKER_CONFIG = {
    concurrency: 3,
    lockDuration: 30000,
    stalledInterval: 30000,
    maxStalledCount: 2,
};

import { bullMqConnection as redisConnection } from '../../../config/redisConnection.js';

// =============================================================================
// ROTEAMENTO — adicione novos handlers aqui sem tocar em outro arquivo
// =============================================================================

const HANDLERS = {
    APPOINTMENT_COMPLETED: mapAppointmentCompleted,
    SESSION_COMPLETED:     mapSessionCompleted,
    PAYMENT_COMPLETED:     mapPaymentCompleted,
};

// =============================================================================
// WORKER
// =============================================================================

let worker = null;

export function startIntegrationOrchestratorWorker() {
    if (worker) {
        console.warn('[IntegrationWorker] Already started');
        return worker;
    }

    worker = new Worker(QUEUE_NAME, processJob, {
        connection: redisConnection,
        ...WORKER_CONFIG,
    });

    worker.on('completed', (job, result) => {
        if (result?.skipped) return; // silencia eventos sem adapter
        console.log(`[IntegrationWorker] Completed: ${job.id}`, {
            eventType: job.data.eventType,
            publishedAs: result?.publishedAs,
        });
    });

    worker.on('failed', (job, err) => {
        console.error(`[IntegrationWorker] Failed: ${job?.id}`, {
            eventType: job?.data?.eventType,
            error: err.message,
            attempts: job?.attemptsMade,
        });
    });

    worker.on('stalled', (jobId) => {
        console.warn(`[IntegrationWorker] Stalled: ${jobId}`);
    });

    worker.on('error', (err) => {
        console.error('[IntegrationWorker] Worker error:', err);
    });

    console.log('[IntegrationWorker] Started successfully');
    return worker;
}

export function stopIntegrationOrchestratorWorker() {
    if (worker) {
        worker.close();
        worker = null;
        console.log('[IntegrationWorker] Stopped');
    }
}

// =============================================================================
// PROCESSOR
// =============================================================================

async function processJob(job) {
    const { eventType, correlationId, payload } = job.data;

    const handler = HANDLERS[eventType];

    if (!handler) {
        console.warn(`[IntegrationWorker] No handler for: ${eventType}`);
        return { skipped: true, reason: 'NO_HANDLER', eventType };
    }

    const translated = handler(job.data);

    if (!translated) {
        // Adapter retornou null → evento filtrado intencionalmente
        return { skipped: true, reason: 'FILTERED_BY_ADAPTER', eventType };
    }

    const result = await publishEvent(translated.type, translated.payload, {
        correlationId,
        aggregateId: payload?.appointmentId || payload?.sessionId || payload?.paymentId,
        metadata: { source: 'integration-orchestrator' },
    });

    return {
        publishedAs: translated.type,
        eventId: result.eventId,
        queues: result.queues,
        duplicate: result.duplicate,
    };
}
