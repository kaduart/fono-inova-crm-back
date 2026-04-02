// workers/createAppointmentWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import { createPackageSession, findAndConsumeReusableCredit } from '../domain/package/consumePackageSession.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { eventExists, processWithGuarantees, appendEvent } from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';
import { createContextLogger } from '../utils/logger.js';
import mongoose from 'mongoose';

/**
 * Create Appointment Worker
 * 
 * Processa evento APPOINTMENT_CREATED:
 * - Cria Session vinculada
 * - Se pacote: reaproveita crédito se disponível
 * - Se particular: publica PAYMENT_REQUESTED
 */

export function startCreateAppointmentWorker() {
    console.log('[CreateAppointmentWorker] 🚀 Iniciando worker...');
    
    const worker = new Worker('appointment-session-creation', async (job) => {
        const { eventId, eventType, correlationId, idempotencyKey, payload } = job.data;
        
        const log = createContextLogger(correlationId, 'create-appointment');

        log.info('job_received', 'Job recebido', {
            jobId: job.id,
            eventType,
            eventId,
            attempt: job.attemptsMade + 1
        });

        // ✅ Eventos que este worker processa
        const validEventTypes = [
            'APPOINTMENT_VALIDATED',          // 🆕 Evento após validação (chain)
            'APPOINTMENT_CREATE_REQUESTED',   // Fallback para compatibilidade
            'APPOINTMENT_CREATED',            // Compatibilidade
            'PACKAGE_APPOINTMENT_REQUESTED',  // Pacote
            'APPOINTMENT_REQUESTED'           // Legado
        ];

        if (!validEventTypes.includes(eventType)) {
            log.warn('unknown_event', 'Ignorando evento não suportado', { eventType });
            return { status: 'ignored', reason: 'UNKNOWN_EVENT_TYPE', eventType };
        }
        
        log.info('processing', 'Processando evento', { eventType, appointmentId: payload.appointmentId });

        // 🛡️ IDEMPOTÊNCIA: Verifica se evento já foi processado
        const existingEvent = await EventStore.findOne({ eventId });
        if (existingEvent && existingEvent.status === 'processed') {
            log.info('already_processed', 'Evento já processado', { eventId });
            return { status: 'already_processed', eventId };
        }

        // 🛡️ IDEMPOTÊNCIA: Verifica idempotencyKey
        if (idempotencyKey && await eventExists(idempotencyKey)) {
            log.info('idempotent', 'Evento já processado (idempotencyKey)', { idempotencyKey });
            return { status: 'already_processed', idempotencyKey };
        }

        const {
            appointmentId,
            patientId,
            doctorId,
            date,
            time,
            specialty,
            serviceType,
            packageId,
            insuranceGuideId,
            amount = 0,
            billingType = 'particular',  // 🐛 FIX: extrai billingType
            userId
        } = payload;

        // 📝 Cria evento no Event Store se não existir
        let eventStoreEvent = existingEvent;
        if (!eventStoreEvent) {
            eventStoreEvent = await appendEvent({
                eventType: EventTypes.APPOINTMENT_CREATE_REQUESTED,
                aggregateType: 'appointment',
                aggregateId: appointmentId,
                payload: job.data.payload,
                idempotencyKey,
                correlationId,
                metadata: {
                    correlationId,
                    source: 'createAppointmentWorker',
                    jobId: job.id
                }
            });
        }

        // 🔄 Processa com garantias
        return await processWithGuarantees(
            eventStoreEvent,
            async (event) => {
                const mongoSession = await mongoose.startSession();
                let session = null;
                let reusedCredit = false;

                try {
                    await mongoSession.startTransaction();
                    log.info('transaction_started', 'Transação iniciada');

                    const appointment = await Appointment.findById(appointmentId)
                        .session(mongoSession);

                    if (!appointment) {
                        log.error('appointment_not_found', 'Appointment não encontrado', { appointmentId });
                        throw new Error('APPOINTMENT_NOT_FOUND');
                    }
                    
                    log.info('appointment_found', 'Appointment encontrado', { 
                        appointmentId, 
                        currentStatus: appointment.operationalStatus 
                    });

                    // Se já tem sessão, ignora
                    if (appointment.session) {
                        log.warn('already_has_session', 'Já tem sessão, abortando', { appointmentId });
                        await mongoSession.abortTransaction();
                        return { status: 'already_has_session', appointmentId };
                    }

                    // CRIA SESSÃO
                    if (packageId) {
                        // PACOTE: Verifica reaproveitamento primeiro
                        const creditData = await findAndConsumeReusableCredit(packageId);
                        reusedCredit = !!creditData;

                        session = await createPackageSession({
                            patientId,
                            doctorId,
                            packageId,
                            appointmentId,
                            date,
                            time,
                            specialty,
                            sessionValue: amount,
                            billingType,
                            creditData,
                            correlationId
                        });

                        // Atualiza appointment
                        appointment.session = session._id;
                        appointment.paymentStatus = session.paymentStatus;
                        appointment.visualFlag = session.visualFlag;
                        appointment.operationalStatus = 'scheduled';

                    } else {
                        // PARTICULAR
                        log.info('creating_private_session', 'Criando sessão PARTICULAR');
                        
                        session = new Session({
                            patient: patientId,
                            doctor: doctorId,
                            appointmentId,
                            date,
                            time,
                            sessionType: specialty,
                            specialty,
                            sessionValue: amount,
                            billingType,  // 🐛 FIX: persiste billingType
                            status: 'scheduled',
                            isPaid: false,
                            paymentStatus: 'pending',
                            visualFlag: 'pending',
                            correlationId,
                            createdAt: new Date()
                        });

                        log.info('saving_session', 'Salvando sessão...');
                        await session.save({ session: mongoSession });
                        log.info('session_saved', 'Sessão salva', { sessionId: session._id });

                        appointment.session = session._id;
                        appointment.operationalStatus = 'scheduled';
                        appointment.paymentStatus = 'pending';
                        
                        log.info('updating_appointment', 'Atualizando appointment...');
                    }

                    await appointment.save({ session: mongoSession });
                    log.info('appointment_updated', 'Appointment atualizado');

                    if (packageId) {
                        await Package.findByIdAndUpdate(
                            packageId,
                            {
                                $addToSet: {
                                    sessions: session._id,
                                    appointments: appointment._id
                                },
                                $set: { updatedAt: new Date() }
                            },
                            { session: mongoSession }
                        );
                        log.info('package_updated', 'Package atualizado com sessão e appointment');
                    }

                    await mongoSession.commitTransaction();
                    log.info('transaction_committed', 'Transação commitada');

                    // Publica eventos pós-criação
                    if (!packageId && amount > 0) {
                        // PARTICULAR: Solicita pagamento
                        await publishEvent(
                            EventTypes.PAYMENT_PROCESS_REQUESTED,
                            {
                                appointmentId: appointmentId.toString(),
                                patientId: patientId?.toString(),
                                doctorId: doctorId?.toString(),
                                amount,
                                sessionId: session._id.toString()
                            },
                            { correlationId }
                        );
                    }

                    log.info('success', 'SUCESSO FINAL', {
                        appointmentId,
                        sessionId: session._id,
                        newStatus: appointment.operationalStatus,
                        reusedCredit,
                        packageId: packageId || null
                    });

                    return {
                        status: 'session_created',
                        appointmentId,
                        sessionId: session._id.toString(),
                        reusedCredit,
                        packageId: packageId || null
                    };

                } catch (error) {
                    // Só aborta se a transação ainda estiver ativa
                    try {
                        if (mongoSession.transaction.state === 'STARTED' || 
                            mongoSession.transaction.state === 'TRANSACTION_STARTED') {
                            await mongoSession.abortTransaction();
                            log.warn('transaction_aborted', 'Transação abortada');
                        }
                    } catch (abortErr) {
                        // Ignora erro de abort - transação já pode ter terminado
                    }
                    
                    log.error('processing_error', 'Erro ao processar', { error: error.message });
                    
                    if (job.attemptsMade >= 4) {
                        await moveToDLQ(job, error);
                    }
                    
                    throw error;
                } finally {
                    mongoSession.endSession();
                }
            },
            'createAppointmentWorker'
        );

    }, {
        connection: redisConnection,
        concurrency: 5
    });

    worker.on('completed', (job, result) => {
        console.log(`[CreateAppointmentWorker] ✅ Job ${job.id}: ${result?.status || 'completed'}`);
    });
    
    worker.on('failed', (job, err) => {
        console.error(`[CreateAppointmentWorker] ❌ Job ${job?.id} FALHOU:`);
        console.error(`   Erro: ${err.message}`);
        console.error(`   Stack: ${err.stack}`);
    });

    console.log('[CreateAppointmentWorker] Worker iniciado');
    return worker;
}
