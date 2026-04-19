/**
 * 🧬 Evolution Worker — V2 (Production-Grade)
 *
 * Princípio: Writes via eventos com idempotência garantida.
 * At-most-once logicamente, mesmo com fila at-least-once.
 *
 * Eventos suportados:
 * - EVOLUTION_CREATE_REQUESTED → salva no MongoDB → emite EVOLUTION_CREATED
 * - EVOLUTION_UPDATE_REQUESTED → atualiza no MongoDB → emite EVOLUTION_UPDATED
 * - EVOLUTION_DELETE_REQUESTED → deleta no MongoDB → emite EVOLUTION_DELETED
 */

import { Worker } from 'bullmq';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';
import Evolution from '../models/Evolution.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';
import { eventExists, processWithGuarantees, appendEvent } from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';

export function startEvolutionWorker() {
    const worker = new Worker('evolution-processing', async (job) => {
        const { eventId, eventType, correlationId, payload } = job.data;
        const log = createContextLogger(correlationId, 'evolution_worker');

        log.info('evolution_processing_started', `Processando ${eventType}: ${eventId}`, {
            patientId: payload.patientId,
            doctorId: payload.doctorId,
            attempt: job.attemptsMade + 1
        });

        // 🛡️ IDEMPOTÊNCIA: verifica se evento já foi processado
        const existingEvent = await EventStore.findOne({ eventId });
        if (existingEvent && existingEvent.status === 'processed') {
            log.info('already_processed', `Evento já processado: ${eventId}`);
            return { status: 'already_processed', eventId };
        }

        // 🛡️ IDEMPOTÊNCIA: verifica idempotencyKey se disponível
        const idempotencyKey = job.data.idempotencyKey || eventId;
        if (idempotencyKey && await eventExists(idempotencyKey)) {
            log.info('already_processed', `Evento com idempotencyKey já processado: ${idempotencyKey}`);
            return { status: 'already_processed', idempotencyKey };
        }

        try {
            // Registra evento no Event Store
            await appendEvent({
                eventType,
                aggregateType: 'evolution',
                aggregateId: payload.appointmentId || payload.evolutionId || eventId,
                payload: job.data,
                idempotencyKey,
                correlationId,
                metadata: {
                    source: 'evolution_worker',
                    workerJobId: job.id
                }
            });

            const result = await processWithGuarantees(
                { eventId, eventType, correlationId, payload },
                async (event) => {
                    if (eventType === EventTypes.EVOLUTION_CREATE_REQUESTED) {
                        return await handleCreate(payload, eventId, correlationId, log);
                    }
                    if (eventType === EventTypes.EVOLUTION_UPDATE_REQUESTED) {
                        return await handleUpdate(payload, eventId, correlationId, log);
                    }
                    if (eventType === EventTypes.EVOLUTION_DELETE_REQUESTED) {
                        return await handleDelete(payload, eventId, correlationId, log);
                    }
                    return { status: 'ignored', reason: 'unknown_event_type' };
                }
            );

            return result;
        } catch (error) {
            log.error('evolution_processing_failed', `Falha em ${eventType}: ${error.message}`, {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 5,
        limiter: { max: 20, duration: 1000 }
    });

    worker.on('completed', (job) => {
        console.log(`[EvolutionWorker] ✅ Job ${job.id} concluído`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[EvolutionWorker] ❌ Job ${job?.id} falhou:`, err.message);
    });

    console.log('[EvolutionWorker] 🚀 Worker iniciado (fila: evolution-processing)');
    return worker;
}

async function handleCreate(payload, eventId, correlationId, log) {
    const { patientId, doctorId, date, appointmentId } = payload;

    // 🛡️ DEDUPE DE NEGÓCIO: se já existe evolution para esse appointment, skip
    if (appointmentId) {
        const existing = await Evolution.findOne({ appointmentId }).lean();
        if (existing) {
            log.info('evolution_duplicate_skipped', `Evolução já existe para appointment ${appointmentId}`, {
                evolutionId: existing._id
            });
            return { status: 'skipped', reason: 'DUPLICATE_APPOINTMENT', evolutionId: existing._id.toString() };
        }
    }

    // 🛡️ DEDUPE DE NEGÓCIO: se já existe evolution para patient+date+doctor, skip
    const dupQuery = { patient: patientId, date: new Date(date), doctor: doctorId };
    const existingDup = await Evolution.findOne(dupQuery).lean();
    if (existingDup) {
        log.info('evolution_duplicate_skipped', `Evolução já existe para patient+date+doctor`, {
            evolutionId: existingDup._id
        });
        return { status: 'skipped', reason: 'DUPLICATE_SESSION', evolutionId: existingDup._id.toString() };
    }

    const evolution = new Evolution({
        patient: patientId,
        doctor: doctorId,
        date: payload.date,
        time: payload.time,
        valuePaid: payload.valuePaid,
        sessionType: payload.sessionType,
        paymentType: payload.paymentType,
        appointmentId: payload.appointmentId,
        plan: payload.plan,
        evaluationTypes: payload.evaluationTypes,
        metrics: payload.metrics,
        evaluationAreas: payload.evaluationAreas,
        notes: payload.notes,
        createdAt: new Date()
    });

    await evolution.save();
    log.info('evolution_created', `Evolução criada: ${evolution._id}`);

    await publishEvent(EventTypes.EVOLUTION_CREATED, {
        evolutionId: evolution._id.toString(),
        patientId,
        doctorId,
        appointmentId: payload.appointmentId,
        date: payload.date
    }, { correlationId: correlationId || `evo_create_${evolution._id}` });

    return { status: 'completed', evolutionId: evolution._id.toString() };
}

async function handleUpdate(payload, eventId, correlationId, log) {
    const { evolutionId, ...updateData } = payload;

    const evolution = await Evolution.findByIdAndUpdate(
        evolutionId,
        { $set: { ...updateData, updatedAt: new Date() } },
        { new: true }
    );

    if (!evolution) {
        log.warn('evolution_not_found', `Evolução não encontrada: ${evolutionId}`);
        return { status: 'failed', reason: 'EVOLUTION_NOT_FOUND' };
    }

    log.info('evolution_updated', `Evolução atualizada: ${evolutionId}`);

    await publishEvent(EventTypes.EVOLUTION_UPDATED, {
        evolutionId: evolution._id.toString(),
        patientId: evolution.patient?.toString?.(),
        doctorId: evolution.doctor?.toString?.()
    }, { correlationId: correlationId || `evo_update_${evolutionId}` });

    return { status: 'completed', evolutionId: evolution._id.toString() };
}

async function handleDelete(payload, eventId, correlationId, log) {
    const { evolutionId } = payload;

    const evolution = await Evolution.findByIdAndDelete(evolutionId);

    if (!evolution) {
        log.warn('evolution_not_found', `Evolução não encontrada: ${evolutionId}`);
        return { status: 'failed', reason: 'EVOLUTION_NOT_FOUND' };
    }

    log.info('evolution_deleted', `Evolução deletada: ${evolutionId}`);

    await publishEvent(EventTypes.EVOLUTION_DELETED, {
        evolutionId,
        patientId: evolution.patient?.toString?.(),
        doctorId: evolution.doctor?.toString?.()
    }, { correlationId: correlationId || `evo_delete_${evolutionId}` });

    return { status: 'completed', evolutionId };
}
