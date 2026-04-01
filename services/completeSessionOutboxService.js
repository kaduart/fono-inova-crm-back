// services/completeSessionOutboxService.js
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import crypto from 'crypto';

/**
 * Versão com OUTBOX PATTERN do complete session
 * 
 * Diferença da versão anterior:
 * - Eventos são salvos no Outbox (tabela MongoDB) dentro da mesma transação
 * - Worker do Outbox publica para fila posteriormente
 * - Garante atomicidade: ou tudo (DB + eventos) ou nada
 * 
 * Fluxo:
 * 1. Valida e busca dados
 * 2. Transação Mongo:
 *    - Atualiza Session, Appointment, Package
 *    - SALVA eventos no Outbox (mesma transação!)
 * 3. Commit
 * 4. Worker do Outbox publica para fila
 */

export async function completeSessionWithOutbox(appointmentId, options = {}) {
    const {
        addToBalance = false,
        balanceAmount = 0,
        balanceDescription = '',
        userId,
        correlationId = `complete_${Date.now()}_${crypto.randomUUID()}`
    } = options;
    
    const startTime = Date.now();
    
    console.log(`[CompleteOutbox] Iniciando`, {
        appointmentId,
        correlationId
    });
    
    // FASE 1: Buscar dados
    const appointment = await Appointment.findById(appointmentId)
        .populate('session patient doctor package')
        .lean();
    
    if (!appointment) {
        throw new Error('Agendamento não encontrado');
    }
    
    // Idempotência
    if (appointment.clinicalStatus === 'completed') {
        return {
            success: true,
            idempotent: true,
            appointmentId,
            correlationId
        };
    }
    
    const sessionId = appointment.session?._id;
    const packageId = appointment.package?._id;
    const patientId = appointment.patient?._id;
    const doctorId = appointment.doctor?._id;
    
    const paymentOrigin = determinePaymentOrigin({
        addToBalance,
        package: appointment.package,
        appointment
    });
    
    // FASE 2: Transação com Outbox
    const mongoSession = await mongoose.startSession();
    const eventsToSave = [];
    
    try {
        await mongoSession.startTransaction();
        
        // 1. Atualizar Session
        if (sessionId) {
            const sessionUpdate = buildSessionUpdate({
                addToBalance,
                paymentOrigin,
                correlationId
            });
            
            await Session.findByIdAndUpdate(sessionId, sessionUpdate, { session: mongoSession });
            
            // Evento de Session Completed
            eventsToSave.push({
                eventId: crypto.randomUUID(),
                eventType: 'SESSION_COMPLETED',
                correlationId,
                payload: {
                    appointmentId,
                    sessionId: sessionId.toString(),
                    patientId: patientId?.toString(),
                    doctorId: doctorId?.toString(),
                    packageId: packageId?.toString(),
                    addToBalance,
                    amount: balanceAmount || appointment.sessionValue,
                    paymentOrigin
                },
                aggregateType: 'session',
                aggregateId: sessionId.toString()
            });
        }
        
        // 2. Atualizar Package
        if (packageId && appointment.clinicalStatus !== 'completed') {
            await Package.updateOne(
                { _id: packageId, $expr: { $lt: ["$sessionsDone", "$totalSessions"] } },
                { $inc: { sessionsDone: 1 }, $set: { updatedAt: new Date() } },
                { session: mongoSession }
            );
        }
        
        // 3. Atualizar Appointment
        const appointmentUpdate = buildAppointmentUpdate({
            addToBalance,
            balanceAmount,
            balanceDescription,
            paymentOrigin,
            correlationId,
            userId,
            packageId,
            appointment
        });
        
        await Appointment.updateOne({ _id: appointmentId }, appointmentUpdate, { session: mongoSession });
        
        // 4. Criar eventos de negócio no Outbox (MESMA TRANSAÇÃO!)
        
        // Evento: Payment Requested (resolve o gap)
        if (!addToBalance && paymentOrigin !== 'manual_balance') {
            eventsToSave.push({
                eventId: crypto.randomUUID(),
                eventType: 'PAYMENT_REQUESTED',
                correlationId,
                payload: {
                    patientId: patientId?.toString(),
                    doctorId: doctorId?.toString(),
                    amount: appointment.sessionValue || balanceAmount,
                    paymentMethod: appointment.paymentMethod || 'dinheiro',
                    sessionId: sessionId?.toString(),
                    appointmentId: appointmentId.toString(),
                    packageId: packageId?.toString(),
                    paymentOrigin,
                    notes: `Pagamento automático - sessão completada`
                },
                aggregateType: 'payment',
                aggregateId: appointmentId.toString()
            });
        }
        
        // Evento: Appointment Completed (para rastreabilidade e E2E)
        eventsToSave.push({
            eventId: crypto.randomUUID(),
            eventType: 'APPOINTMENT_COMPLETED',
            correlationId,
            payload: {
                appointmentId: appointmentId.toString(),
                patientId: patientId?.toString(),
                doctorId: doctorId?.toString(),
                sessionId: sessionId?.toString(),
                packageId: packageId?.toString(),
                paymentOrigin
            },
            aggregateType: 'appointment',
            aggregateId: appointmentId.toString()
        });

        // Evento: Balance Update
        if (addToBalance && patientId) {
            eventsToSave.push({
                eventId: crypto.randomUUID(),
                eventType: 'BALANCE_UPDATE_REQUESTED',
                correlationId,
                payload: {
                    patientId: patientId.toString(),
                    amount: balanceAmount || appointment.sessionValue,
                    description: balanceDescription || `Sessão ${appointment.date} - pagamento pendente`,
                    sessionId: sessionId?.toString(),
                    appointmentId: appointmentId.toString(),
                    registeredBy: userId?.toString()
                },
                aggregateType: 'patient_balance',
                aggregateId: patientId.toString()
            });
        }
        
        // Salvar todos os eventos no Outbox (dentro da transação!)
        for (const event of eventsToSave) {
            await saveToOutbox(event, mongoSession);
        }
        
        // Commit tudo (DB + Outbox)
        await mongoSession.commitTransaction();
        
        console.log(`[CompleteOutbox] Transação commitada (${Date.now() - startTime}ms)`, {
            eventsSaved: eventsToSave.length
        });
        
    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
    
    // FASE 3: Retornar imediatamente
    // Os eventos serão publicados pelo Outbox Worker
    
    return {
        success: true,
        appointmentId,
        correlationId,
        eventsQueued: eventsToSave.map(e => ({
            eventType: e.eventType,
            eventId: e.eventId
        })),
        message: addToBalance 
            ? 'Sessão completada - adicionado ao saldo devedor'
            : 'Sessão completada - pagamento em processamento'
    };
}

// Helpers (mesmos da versão anterior)
function determinePaymentOrigin({ addToBalance, package: pkg, appointment }) {
    if (addToBalance) return 'manual_balance';
    if (pkg?.type === 'convenio') return 'convenio';
    if (pkg?.type === 'liminar') return 'liminar';
    if (pkg?.paymentType === 'per-session') return 'auto_per_session';
    if (pkg) return 'package_prepaid';
    return 'individual';
}

function buildSessionUpdate({ addToBalance, paymentOrigin, correlationId }) {
    if (addToBalance) {
        return {
            status: 'completed',
            isPaid: false,
            paymentStatus: 'pending',
            paymentOrigin,
            correlationId,
            visualFlag: 'pending',
            updatedAt: new Date()
        };
    }
    return {
        status: 'completed',
        isPaid: true,
        paymentStatus: 'paid',
        paymentOrigin,
        correlationId,
        visualFlag: 'ok',
        updatedAt: new Date()
    };
}

function buildAppointmentUpdate({
    addToBalance,
    balanceAmount,
    balanceDescription,
    paymentOrigin,
    correlationId,
    userId,
    packageId,
    appointment
}) {
    const update = {
        $set: {
            operationalStatus: 'confirmed',
            clinicalStatus: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
            paymentOrigin,
            correlationId
        },
        $push: {
            history: {
                action: addToBalance ? 'confirmed_with_balance' : 'confirmed',
                newStatus: 'confirmed',
                changedBy: userId,
                timestamp: new Date(),
                context: addToBalance ? `Saldo: ${balanceAmount}` : 'operacional'
            }
        }
    };
    
    if (addToBalance) {
        update.$set.paymentStatus = 'pending';
        update.$set.visualFlag = 'pending';
        update.$set.addedToBalance = true;
        update.$set.balanceAmount = balanceAmount || appointment.sessionValue;
        update.$set.balanceDescription = balanceDescription || 'Sessão utilizada - pagamento pendente';
    } else if (packageId) {
        if (appointment.package?.type === 'convenio') {
            update.$set.paymentStatus = 'pending_receipt';
            update.$set.visualFlag = 'pending';
        } else {
            update.$set.paymentStatus = 'package_paid';
            update.$set.visualFlag = 'ok';
        }
    } else {
        update.$set.paymentStatus = 'paid';
        update.$set.visualFlag = 'ok';
    }
    
    return update;
}
