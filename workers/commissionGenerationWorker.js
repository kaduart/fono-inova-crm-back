// workers/commissionGenerationWorker.js
// Processa geração mensal de comissões em background (BullMQ)

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { EventTypes, publishEvent } from '../infrastructure/events/eventPublisher.js';
import { processWithGuarantees, eventExists, appendEvent, markEventProcessed } from '../infrastructure/events/eventStoreService.js';
import { generateMonthlyCommissions } from '../services/commissionService.js';
import { createContextLogger } from '../utils/logger.js';
import EventStore from '../models/EventStore.js';

export function startCommissionGenerationWorker() {
    console.log('[CommissionGenerationWorker] 🚀 Iniciando worker...');

    const worker = new Worker('commission-generation', async (job) => {
        const { eventId, eventType, correlationId, idempotencyKey, payload } = job.data;
        const log = createContextLogger(correlationId, 'commission-generation');

        log.info('job_received', 'Job de geração de comissões recebido', {
            jobId: job.id,
            eventId,
            eventType,
            attempt: job.attemptsMade + 1
        });

        if (eventType !== EventTypes.COMMISSION_GENERATION_REQUESTED) {
            log.warn('unknown_event', 'Ignorando evento não suportado', { eventType });
            await markEventProcessed(eventId, 'commissionGenerationWorker');
            return { status: 'ignored', reason: 'UNKNOWN_EVENT_TYPE', eventType };
        }

        // 🛡️ IDEMPOTÊNCIA: verifica se já foi processado
        const existingEvent = await EventStore.findOne({ eventId });
        if (existingEvent && existingEvent.status === 'processed') {
            log.info('already_processed', 'Evento já processado', { eventId });
            return { status: 'already_processed', eventId };
        }

        if (idempotencyKey && await eventExists(idempotencyKey)) {
            log.info('idempotent', 'Evento já processado (idempotencyKey)', { idempotencyKey });
            return { status: 'already_processed', idempotencyKey };
        }

        // 📝 Garante que o evento existe no Event Store
        let eventStoreEvent = existingEvent;
        if (!eventStoreEvent) {
            eventStoreEvent = await appendEvent({
                eventType: EventTypes.COMMISSION_GENERATION_REQUESTED,
                aggregateType: 'commission',
                aggregateId: payload.aggregateId,
                payload: payload,
                idempotencyKey,
                correlationId,
                metadata: {
                    correlationId,
                    source: 'commissionGenerationWorker',
                    jobId: job.id
                }
            });
        }

        // 🔄 Processa com garantias (marca processing → processado/falhou)
        return await processWithGuarantees(
            eventStoreEvent,
            async () => {
                const { month, year } = payload;
                const result = await generateMonthlyCommissions(
                    month ? Number(month) : undefined,
                    year ? Number(year) : undefined
                );

                log.info('commissions_generated', 'Comissões geradas com sucesso', {
                    eventId,
                    generated: result.generated,
                    totalDoctors: result.totalDoctors
                });

                // Publica evento de conclusão para auditoria/projeções futuras
                await publishEvent(
                    EventTypes.COMMISSION_GENERATION_COMPLETED,
                    {
                        originalEventId: eventId,
                        ...result
                    },
                    { correlationId }
                );

                return result;
            },
            'commissionGenerationWorker'
        );
    }, {
        connection: redisConnection,
        concurrency: 1, // Garante processamento serial de comissões
        limiter: {
            max: 1,
            duration: 1000
        }
    });

    worker.on('completed', (job, result) => {
        console.log(`[CommissionGenerationWorker] ✅ Job ${job.id} completado`, result?.status || '');
    });

    worker.on('failed', async (job, error) => {
        console.error(`[CommissionGenerationWorker] ❌ Job ${job?.id} falhou:`, error.message);
        if (job && job.attemptsMade >= (job.opts.attempts || 5) - 1) {
            try {
                await moveToDLQ(job, error, 'commission-generation-dlq');
            } catch (dlqError) {
                console.error('[CommissionGenerationWorker] ❌ Erro ao mover para DLQ:', dlqError.message);
            }
        }
    });

    return worker;
}
