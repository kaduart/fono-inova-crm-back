// workers/appointmentWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

/**
 * Appointment Worker
 * 
 * Responsabilidade: Processar eventos de agendamento
 * - Valida conflito de horário
 * - Valida disponibilidade do profissional
 * - Confirma ou rejeita agendamento
 * - Publica eventos seguintes (pagamento, notificação, etc)
 * 
 * State Machine:
 * pending → validating → confirmed | rejected
 */

const processedEvents = new Map();
const EVENT_CACHE_TTL = 24 * 60 * 60 * 1000;

// Limpa cache
setInterval(() => {
    const now = Date.now();
    for (const [eventId, timestamp] of processedEvents) {
        if (now - timestamp > EVENT_CACHE_TTL) processedEvents.delete(eventId);
    }
}, 60 * 60 * 1000);

export function startAppointmentWorker() {
    const worker = new Worker('appointment-processing', async (job) => {
        const { eventId, eventType, correlationId, payload } = job.data;
        
        console.log(`[AppointmentWorker] Processando ${eventType}: ${eventId}`);

        // 1. IDEMPOTÊNCIA
        if (processedEvents.has(eventId)) {
            console.log(`[AppointmentWorker] Evento já processado: ${eventId}`);
            return { status: 'already_processed' };
        }

        try {
            // 2. Busca agendamento
            const appointment = await Appointment.findById(payload.appointmentId);
            
            if (!appointment) {
                throw new Error(`APPOINTMENT_NOT_FOUND: ${payload.appointmentId}`);
            }

            // 3. STATE GUARD: Só processa se estiver pending ou processing_create (4.0)
            const processableStatuses = ['pending', 'processing_create'];
            if (!processableStatuses.includes(appointment.operationalStatus)) {
                console.log(`[AppointmentWorker] Agendamento ${appointment._id} já processado (status: ${appointment.operationalStatus})`);
                return { status: 'already_handled', currentStatus: appointment.operationalStatus };
            }

            // 4. Atualiza para 'validating'
            await Appointment.findByIdAndUpdate(appointment._id, {
                operationalStatus: 'validating',
                $push: {
                    history: {
                        action: 'validation_started',
                        newStatus: 'validating',
                        timestamp: new Date()
                    }
                }
            });

            // 5. VALIDAÇÕES DE NEGÓCIO
            const validations = await runValidations(appointment, payload);
            
            if (!validations.success) {
                // REJEITA
                await rejectAppointment(appointment._id, validations.reason, validations.details);
                
                // Publica evento de rejeição
                await publishEvent(
                    EventTypes.APPOINTMENT_REJECTED,
                    {
                        appointmentId: appointment._id.toString(),
                        reason: validations.reason,
                        details: validations.details
                    },
                    { correlationId }
                );
                
                processedEvents.set(eventId, Date.now());
                
                return {
                    status: 'rejected',
                    appointmentId: appointment._id.toString(),
                    reason: validations.reason
                };
            }

            // 6. CONFIRMA AGENDAMENTO
            await confirmAppointment(appointment._id);

            // 7. Publica eventos seguintes baseado no tipo
            await publishNextEvents(appointment, payload, correlationId);

            processedEvents.set(eventId, Date.now());

            console.log(`[AppointmentWorker] Agendamento ${appointment._id} confirmado`);

            return {
                status: 'confirmed',
                appointmentId: appointment._id.toString()
            };

        } catch (error) {
            console.error(`[AppointmentWorker] Erro:`, error.message);
            
            if (job.attemptsMade >= 4) {
                await moveToDLQ(job, error);
            }
            
            throw error; // Trigger retry
        }

    }, {
        connection: redisConnection,
        concurrency: 5,
        limiter: { max: 10, duration: 1000 }
    });

    worker.on('completed', (job, result) => {
        console.log(`[AppointmentWorker] Job ${job.id}: ${result.status}`);
    });

    worker.on('failed', (job, error) => {
        console.error(`[AppointmentWorker] Job ${job?.id} falhou:`, error.message);
    });

    console.log('[AppointmentWorker] Worker iniciado');
    return worker;
}

/**
 * Roda todas as validações de negócio
 */
async function runValidations(appointment, payload) {
    // 1. Validar conflito de horário
    const conflict = await Appointment.findOne({
        _id: { $ne: appointment._id },
        doctor: appointment.doctor,
        date: appointment.date,
        time: appointment.time,
        operationalStatus: { $nin: ['canceled', 'rejected'] }
    });

    if (conflict) {
        return {
            success: false,
            reason: 'SLOT_TAKEN',
            details: { conflictAppointmentId: conflict._id.toString() }
        };
    }

    // 2. Validar horário de trabalho do profissional
    const doctor = await Doctor.findById(appointment.doctor);
    if (!doctor) {
        return {
            success: false,
            reason: 'DOCTOR_NOT_FOUND'
        };
    }

    // TODO: Validar se horário está dentro da agenda do profissional
    // TODO: Validar feriados, folgas, etc

    // 3. Validar se paciente não tem agendamento no mesmo horário
    const patientConflict = await Appointment.findOne({
        _id: { $ne: appointment._id },
        patient: appointment.patient,
        date: appointment.date,
        time: appointment.time,
        operationalStatus: { $nin: ['canceled', 'rejected'] }
    });

    if (patientConflict) {
        return {
            success: false,
            reason: 'PATIENT_DOUBLE_BOOKING',
            details: { existingAppointmentId: patientConflict._id.toString() }
        };
    }

    // 4. Validações específicas por tipo
    if (payload.packageId) {
        // Será validado pelo packageValidationWorker
        // Aqui apenas marcamos que precisa de validação adicional
        console.log(`[AppointmentWorker] Agendamento de pacote - aguardando validação de crédito`);
    }

    if (payload.insuranceGuideId) {
        // Será validado pelo insuranceWorker
        console.log(`[AppointmentWorker] Agendamento de convênio - aguardando validação de guia`);
    }

    return { success: true };
}

/**
 * Confirma agendamento
 */
async function confirmAppointment(appointmentId) {
    await Appointment.findByIdAndUpdate(appointmentId, {
        operationalStatus: 'scheduled',
        $push: {
            history: {
                action: 'appointment_confirmed',
                newStatus: 'scheduled',
                timestamp: new Date()
            }
        }
    });
}

/**
 * Rejeita agendamento
 */
async function rejectAppointment(appointmentId, reason, details) {
    await Appointment.findByIdAndUpdate(appointmentId, {
        operationalStatus: 'rejected',
        rejectionReason: reason,
        rejectionDetails: details,
        $push: {
            history: {
                action: 'appointment_rejected',
                newStatus: 'rejected',
                timestamp: new Date(),
                context: reason
            }
        }
    });
}

/**
 * Publica eventos seguintes baseado no tipo de agendamento
 */
async function publishNextEvents(appointment, payload, correlationId) {
    const events = [];

    // Evento: Agendamento confirmado
    events.push({
        eventType: EventTypes.APPOINTMENT_CONFIRMED,
        payload: {
            appointmentId: appointment._id.toString(),
            patientId: appointment.patient?.toString(),
            doctorId: appointment.doctor?.toString(),
            date: appointment.date,
            time: appointment.time
        }
    });

    // Se for particular com pagamento: solicita pagamento
    if (!payload.packageId && !payload.insuranceGuideId && payload.amount > 0) {
        events.push({
            eventType: EventTypes.PAYMENT_REQUESTED,
            payload: {
                appointmentId: appointment._id.toString(),
                patientId: payload.patientId,
                doctorId: payload.doctorId,
                amount: payload.amount,
                paymentMethod: payload.paymentMethod,
                notes: `Pagamento referente ao agendamento ${appointment._id}`
            }
        });
    }

    // Se for pacote: valida crédito
    if (payload.packageId) {
        events.push({
            eventType: EventTypes.PACKAGE_VALIDATION_REQUESTED,
            payload: {
                appointmentId: appointment._id.toString(),
                packageId: payload.packageId,
                patientId: payload.patientId
            }
        });
    }

    // Se for convênio: valida guia
    if (payload.insuranceGuideId) {
        events.push({
            eventType: EventTypes.INSURANCE_VALIDATION_REQUESTED,
            payload: {
                appointmentId: appointment._id.toString(),
                guideId: payload.insuranceGuideId,
                patientId: payload.patientId
            }
        });
    }

    // Notificação (WhatsApp/email)
    events.push({
        eventType: EventTypes.NOTIFICATION_REQUESTED,
        payload: {
            appointmentId: appointment._id.toString(),
            type: 'APPOINTMENT_CONFIRMED',
            patientId: payload.patientId,
            channels: ['whatsapp', 'email']
        },
        options: { delay: 5000 } // Delay de 5s para não spammar
    });

    // Publica todos
    for (const event of events) {
        try {
            await publishEvent(event.eventType, event.payload, {
                ...event.options,
                correlationId
            });
        } catch (error) {
            console.error(`[AppointmentWorker] Falha ao publicar ${event.eventType}:`, error.message);
            // Não falha o job, apenas loga
        }
    }
}
