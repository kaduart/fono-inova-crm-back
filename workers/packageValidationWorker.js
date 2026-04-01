// workers/packageValidationWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Package from '../models/Package.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

/**
 * Package Validation Worker
 * 
 * Responsabilidade: Validar e consumir crédito de pacotes
 * - Verifica se pacote tem sessões disponíveis
 * - Consome crédito (session do pacote)
 * - Atualiza status do agendamento
 * 
 * State Guard: Só processa se agendamento estiver 'scheduled'
 */

const processedEvents = new Map();

export function startPackageValidationWorker() {
    const worker = new Worker('package-validation', async (job) => {
        const { eventId, correlationId, payload } = job.data;
        const { appointmentId, packageId, patientId } = payload;

        console.log(`[PackageValidationWorker] Validando pacote ${packageId} para agendamento ${appointmentId}`);

        // Idempotência
        if (processedEvents.has(eventId)) {
            return { status: 'already_processed' };
        }

        try {
            // 1. Busca pacote
            const pkg = await Package.findById(packageId);
            
            if (!pkg) {
                throw new Error(`PACKAGE_NOT_FOUND: ${packageId}`);
            }

            // 2. STATE GUARD: Verifica se agendamento ainda existe e está scheduled
            const appointment = await Appointment.findById(appointmentId);
            
            if (!appointment) {
                throw new Error(`APPOINTMENT_NOT_FOUND: ${appointmentId}`);
            }

            if (appointment.operationalStatus === 'rejected' || appointment.operationalStatus === 'canceled') {
                console.log(`[PackageValidationWorker] Agendamento ${appointmentId} cancelado/rejeitado. Abortando.`);
                return { status: 'aborted', reason: 'appointment_cancelled' };
            }

            // 3. Verifica crédito disponível
            const remainingSessions = pkg.totalSessions - (pkg.sessionsDone || 0);
            
            if (remainingSessions <= 0) {
                // Sem crédito: rejeita agendamento
                await rejectDueToNoCredit(appointmentId, packageId);
                
                await publishEvent(
                    EventTypes.APPOINTMENT_REJECTED,
                    {
                        appointmentId,
                        reason: 'PACKAGE_NO_CREDIT',
                        details: { packageId, remainingSessions: 0 }
                    },
                    { correlationId }
                );
                
                processedEvents.set(eventId, Date.now());
                
                return {
                    status: 'rejected',
                    reason: 'PACKAGE_NO_CREDIT'
                };
            }

            // 4. Cria sessão do pacote
            const session = await createPackageSession(pkg, appointment);

            // 5. Atualiza pacote (incrementa sessionsDone)
            await Package.findByIdAndUpdate(packageId, {
                $inc: { sessionsDone: 1 },
                $push: { sessions: session._id, appointments: appointmentId }
            });

            // 6. Atualiza agendamento com referência da sessão
            await Appointment.findByIdAndUpdate(appointmentId, {
                session: session._id,
                paymentStatus: 'package_paid',
                $push: {
                    history: {
                        action: 'package_credit_consumed',
                        newStatus: appointment.operationalStatus,
                        timestamp: new Date(),
                        context: `Pacote ${packageId}: sessão ${session._id}`
                    }
                }
            });

            // 7. Publica evento de sucesso
            await publishEvent(
                EventTypes.PACKAGE_CREDIT_CONSUMED,
                {
                    appointmentId,
                    packageId,
                    sessionId: session._id.toString(),
                    remainingSessions: remainingSessions - 1
                },
                { correlationId }
            );

            processedEvents.set(eventId, Date.now());

            console.log(`[PackageValidationWorker] Crédito consumido: ${session._id}`);

            return {
                status: 'credit_consumed',
                sessionId: session._id.toString(),
                remainingSessions: remainingSessions - 1
            };

        } catch (error) {
            console.error(`[PackageValidationWorker] Erro:`, error.message);
            
            if (job.attemptsMade >= 4) {
                await moveToDLQ(job, error);
            }
            
            throw error;
        }

    }, {
        connection: redisConnection,
        concurrency: 3
    });

    worker.on('completed', (job, result) => {
        console.log(`[PackageValidationWorker] Job ${job.id}: ${result.status}`);
    });

    console.log('[PackageValidationWorker] Worker iniciado');
    return worker;
}

/**
 * Cria sessão vinculada ao pacote
 */
async function createPackageSession(pkg, appointment) {
    const session = new Session({
        patient: appointment.patient,
        doctor: appointment.doctor,
        package: pkg._id,
        appointmentId: appointment._id,
        date: appointment.date,
        time: appointment.time,
        sessionType: appointment.specialty,
        sessionValue: pkg.sessionValue || 0,
        status: 'scheduled',
        isPaid: true, // Pago pelo pacote
        paymentStatus: 'package_paid',
        paymentOrigin: 'package_prepaid',
        visualFlag: 'ok',
        correlationId: appointment.correlationId
    });

    await session.save();
    return session;
}

/**
 * Rejeita agendamento por falta de crédito
 */
async function rejectDueToNoCredit(appointmentId, packageId) {
    await Appointment.findByIdAndUpdate(appointmentId, {
        operationalStatus: 'rejected',
        rejectionReason: 'PACKAGE_NO_CREDIT',
        rejectionDetails: { packageId },
        $push: {
            history: {
                action: 'appointment_rejected',
                newStatus: 'rejected',
                timestamp: new Date(),
                context: 'Pacote sem crédito disponível'
            }
        }
    });
}
