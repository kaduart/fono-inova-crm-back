// services/completeSessionEventService.js
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

/**
 * Serviço de Complete Session - Versão Event-Driven
 * 
 * Características:
 * - Transação Mongo MÍNIMA (apenas dados críticos)
 * - NÃO cria Payment dentro da transação (elimina gap)
 * - Publica eventos para processamento assíncrono
 * - 100% idempotente
 * 
 * Fluxo:
 * 1. Valida e busca dados
 * 2. Executa transação (Session, Appointment, Package)
 * 3. Publica eventos (Payment, Balance, Sync)
 * 4. Retorna imediatamente
 */

export async function completeSessionEventDriven(appointmentId, options = {}) {
    const {
        addToBalance = false,
        balanceAmount = 0,
        balanceDescription = '',
        userId,
        correlationId = `complete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    } = options;
    
    const startTime = Date.now();
    
    console.log(`[CompleteSession] Iniciando (event-driven)`, {
        appointmentId,
        addToBalance,
        correlationId
    });
    
    // ============================================================
    // FASE 1: BUSCAR DADOS (FORA DA TRANSAÇÃO)
    // ============================================================
    const appointment = await Appointment.findById(appointmentId)
        .populate('session patient doctor package')
        .lean();
    
    if (!appointment) {
        throw new Error('Agendamento não encontrado');
    }
    
    // IDEMPOTÊNCIA: Verifica se já foi completado
    if (appointment.clinicalStatus === 'completed') {
        console.log(`[CompleteSession] Sessão ${appointmentId} já completada (idempotência)`);
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
    
    // Determina origem do pagamento
    const paymentOrigin = determinePaymentOrigin({
        addToBalance,
        package: appointment.package,
        appointment
    });
    
    // ============================================================
    // FASE 2: TRANSAÇÃO MÍNIMA (apenas dados críticos)
    // ============================================================
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();
        
        // 1. Atualizar Session
        if (sessionId) {
            const sessionUpdate = buildSessionUpdate({
                addToBalance,
                paymentOrigin,
                correlationId
            });
            
            await Session.findByIdAndUpdate(
                sessionId,
                sessionUpdate,
                { session: mongoSession }
            );
        }
        
        // 2. Atualizar Package (incrementar sessionsDone)
        if (packageId && appointment.clinicalStatus !== 'completed') {
            await Package.updateOne(
                {
                    _id: packageId,
                    $expr: { $lt: ["$sessionsDone", "$totalSessions"] }
                },
                {
                    $inc: { sessionsDone: 1 },
                    $set: { updatedAt: new Date() }
                },
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
        
        await Appointment.updateOne(
            { _id: appointmentId },
            appointmentUpdate,
            { session: mongoSession }
        );
        
        await mongoSession.commitTransaction();
        
        console.log(`[CompleteSession] Transação commitada (${Date.now() - startTime}ms)`);
        
    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
    
    // ============================================================
    // FASE 3: PUBLICAR EVENTOS (não bloqueia resposta)
    // ============================================================
    const eventsToPublish = [];
    
    // Evento 1: Session Completed (para audit trail e integrações)
    eventsToPublish.push({
        eventType: EventTypes.SESSION_COMPLETED,
        payload: {
            appointmentId,
            sessionId,
            patientId,
            doctorId,
            packageId,
            addToBalance,
            amount: balanceAmount || appointment.sessionValue,
            paymentType: paymentOrigin,  // ✅ Usado pelo billing worker
            paymentOrigin,                // ✅ Mantido para compatibilidade
            specialty: appointment.specialty
        }
    });
    
    // Evento 2: Payment Requested (resolve o "gap")
    // Só cria pagamento se não for saldo devedor
    if (!addToBalance && paymentOrigin !== 'manual_balance') {
        eventsToPublish.push({
            eventType: EventTypes.PAYMENT_REQUESTED,
            payload: {
                patientId,
                doctorId,
                amount: appointment.sessionValue || balanceAmount,
                paymentMethod: appointment.paymentMethod || 'dinheiro',
                sessionId,
                appointmentId,
                packageId,
                paymentOrigin,
                notes: `Pagamento automático - sessão completada`
            }
        });
    }
    
    // Evento 3: Balance Update (se for saldo devedor)
    if (addToBalance && patientId) {
        eventsToPublish.push({
            eventType: EventTypes.BALANCE_UPDATE_REQUESTED,
            payload: {
                patientId,
                amount: balanceAmount || appointment.sessionValue,
                description: balanceDescription || `Sessão ${appointment.date} - pagamento pendente`,
                sessionId,
                appointmentId,
                registeredBy: userId
            }
        });
    }
    
    // Evento 4: Sync (menor prioridade)
    eventsToPublish.push({
        eventType: EventTypes.SYNC_MEDICAL_EVENT,
        payload: {
            appointmentId,
            sessionId,
            action: 'SESSION_COMPLETED'
        },
        options: {
            delay: 5000 // Delay de 5s para não competir com eventos críticos
        }
    });
    
    // Publica todos os eventos com o mesmo correlationId
    const publishResults = [];
    for (const { eventType, payload, options: eventOptions = {} } of eventsToPublish) {
        try {
            const result = await publishEvent(eventType, payload, {
                ...eventOptions,
                correlationId
            });
            publishResults.push(result);
        } catch (error) {
            console.error(`[CompleteSession] Falha ao publicar ${eventType}:`, error.message);
            // Não falha o request, apenas loga
            // O evento pode ser republicado manualmente ou via job de reconciliação
        }
    }
    
    console.log(`[CompleteSession] Finalizado`, {
        duration: Date.now() - startTime,
        eventsPublished: publishResults.length,
        correlationId
    });
    
    return {
        success: true,
        appointmentId,
        correlationId,
        eventsPublished: publishResults.map(r => ({
            eventId: r.eventId,
            eventType: r.eventType
        })),
        message: addToBalance 
            ? 'Sessão completada - adicionado ao saldo devedor'
            : 'Sessão completada - pagamento em processamento'
    };
}

// ============================================================
// HELPERS
// ============================================================

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
