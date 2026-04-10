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

        console.log(`[PackageValidationWorker] Validando pacote ${packageId} para agendamento ${appointmentId || '(buscando no pacote)'}`);

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

            // Se veio appointmentId explícito, processa apenas ele
            if (appointmentId) {
                const result = await processSingleAppointment({
                    pkg,
                    appointmentId,
                    packageId,
                    correlationId
                });
                processedEvents.set(eventId, Date.now());
                return result;
            }

            // Se não veio appointmentId, busca appointments do pacote que ainda não têm session vinculada
            const pendingAppointments = await Appointment.find({
                package: packageId,
                $or: [
                    { session: { $exists: false } },
                    { session: null }
                ],
                operationalStatus: { $nin: ['rejected', 'canceled'] }
            });

            if (!pendingAppointments.length) {
                console.log(`[PackageValidationWorker] Nenhum agendamento pendente para o pacote ${packageId}. Ignorando.`);
                return { status: 'skipped', reason: 'no_pending_appointments' };
            }

            const results = [];
            for (const appt of pendingAppointments) {
                const result = await processSingleAppointment({
                    pkg,
                    appointmentId: appt._id.toString(),
                    packageId,
                    correlationId
                });
                results.push(result);
                // Recarrega pacote para próxima iteração ter sessionsDone atualizado
                pkg.sessionsDone = (pkg.sessionsDone || 0) + 1;
            }

            processedEvents.set(eventId, Date.now());

            return {
                status: 'batch_processed',
                processed: results.length,
                results
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
 * Processa consumo de crédito para um único appointment
 */
async function processSingleAppointment({ pkg, appointmentId, packageId, correlationId }) {
    const appointment = await Appointment.findById(appointmentId);

    if (!appointment) {
        throw new Error(`APPOINTMENT_NOT_FOUND: ${appointmentId}`);
    }

    if (appointment.operationalStatus === 'rejected' || appointment.operationalStatus === 'canceled') {
        console.log(`[PackageValidationWorker] Agendamento ${appointmentId} cancelado/rejeitado. Abortando.`);
        return { status: 'aborted', reason: 'appointment_cancelled' };
    }

    // Se já tem session vinculada, pula
    if (appointment.session) {
        return { status: 'skipped', reason: 'already_has_session' };
    }

    const remainingSessions = pkg.totalSessions - (pkg.sessionsDone || 0);

    if (remainingSessions <= 0) {
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

        return {
            status: 'rejected',
            reason: 'PACKAGE_NO_CREDIT'
        };
    }

    const session = await createPackageSession(pkg, appointment);

    await Package.findByIdAndUpdate(packageId, {
        $inc: { sessionsDone: 1 },
        $push: { sessions: session._id, appointments: appointmentId }
    });

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

    console.log(`[PackageValidationWorker] Crédito consumido: ${session._id}`);

    return {
        status: 'credit_consumed',
        sessionId: session._id.toString(),
        remainingSessions: remainingSessions - 1
    };
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
        sessionType: appointment.specialty || 'fonoaudiologia',
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
