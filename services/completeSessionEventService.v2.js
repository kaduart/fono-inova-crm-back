// services/completeSessionEventService.v2.js
// 🚀 VERSÃO COM FINANCIAL GUARD - Complete Session centralizado

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import FinancialGuard from './financialGuard/index.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

/**
 * Serviço de Complete Session - Versão Financial Guard
 * 
 * Características:
 * - Transação Mongo com Financial Guard (package financeiro na transaction)
 * - Centralização de regras financeiras por billingType
 * - 100% idempotente
 */

export async function completeSessionEventDrivenV2(appointmentId, options = {}) {
    const {
        addToBalance = false,
        balanceAmount = 0,
        balanceDescription = '',
        userId,
        correlationId = `complete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    } = options;
    
    const startTime = Date.now();
    
    console.log(`[CompleteSessionV2] Iniciando (Financial Guard)`, {
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
    
    // IDEMPOTÊNCIA
    if (appointment.clinicalStatus === 'completed') {
        console.log(`[CompleteSessionV2] Sessão ${appointmentId} já completada`);
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
    
    // Determina billing type
    const billingType = determineBillingType({
        addToBalance,
        package: appointment.package,
        appointment
    });
    
    const paymentOrigin = determinePaymentOrigin({
        addToBalance,
        package: appointment.package,
        appointment
    });
    
    // ============================================================
    // FASE 2: TRANSAÇÃO COM FINANCIAL GUARD
    // ============================================================
    const mongoSession = await mongoose.startSession();
    let financialResult = null;
    
    try {
        await mongoSession.startTransaction();
        
        // 1. Atualizar Session (core)
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
        
        // 2. 🔥 FINANCIAL GUARD (regras financeiras por tipo)
        // Chama para TODOS os tipos: package, insurance, legal, particular
        if (!addToBalance) {
            try {
                financialResult = await FinancialGuard.execute({
                    context: 'COMPLETE_SESSION',
                    billingType: billingType, // 'package', 'insurance', 'legal', ou 'particular'
                    payload: {
                        packageId: packageId?.toString(),
                        appointmentId: appointmentId.toString(),
                        sessionValue: appointment.sessionValue || 0,
                        paymentOrigin,
                        billingType: appointment?.billingType // valor original
                    },
                    session: mongoSession
                });
                
                if (financialResult?.handled) {
                    console.log('[CompleteSessionV2] 💰 Financial Guard executado:', financialResult);
                } else if (financialResult?.reason === 'BILLING_TYPE_NOT_MAPPED') {
                    console.log(`[CompleteSessionV2] ⚠️ Financial Guard não mapeado para ${billingType}, continuando sem guard`);
                }
            } catch (financialErr) {
                console.error('[CompleteSessionV2] ❌ ERRO no Financial Guard:', financialErr.message);
                throw new Error(`FINANCIAL_GUARD_FAILED: ${financialErr.message}`);
            }
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
        
        console.log(`[CompleteSessionV2] ✅ Transação commitada (${Date.now() - startTime}ms)`);
        
    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
    
    // ============================================================
    // FASE 3: PUBLICAR EVENTOS (não bloqueia)
    // ============================================================
    const eventsToPublish = [];
    
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
            paymentType: paymentOrigin,
            paymentOrigin,
            specialty: appointment.specialty,
            financialResult
        }
    });
    
    // Payment Requested (apenas se não for saldo devedor)
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
                paymentOrigin
            }
        });
    }
    
    // Balance Update (se for saldo devedor)
    if (addToBalance && patientId) {
        eventsToPublish.push({
            eventType: EventTypes.BALANCE_UPDATE_REQUESTED,
            payload: {
                patientId,
                amount: balanceAmount || appointment.sessionValue,
                description: balanceDescription || `Sessão ${appointment.date}`,
                sessionId,
                appointmentId,
                registeredBy: userId
            }
        });
    }
    
    // Publica eventos
    const publishResults = [];
    for (const { eventType, payload, options: eventOptions = {} } of eventsToPublish) {
        try {
            const result = await publishEvent(eventType, payload, {
                ...eventOptions,
                correlationId
            });
            publishResults.push(result);
        } catch (error) {
            console.error(`[CompleteSessionV2] Falha ao publicar ${eventType}:`, error.message);
        }
    }
    
    console.log(`[CompleteSessionV2] Finalizado`, {
        duration: Date.now() - startTime,
        eventsPublished: publishResults.length,
        correlationId
    });
    
    return {
        success: true,
        appointmentId,
        correlationId,
        financialResult,
        eventsPublished: publishResults.map(r => ({
            eventId: r.eventId,
            eventType: r.eventType
        })),
        message: addToBalance 
            ? 'Sessão completada - adicionado ao saldo'
            : 'Sessão completada - pagamento em processamento'
    };
}

// ============================================================
// HELPERS
// ============================================================

function determineBillingType({ addToBalance, package: pkg, appointment }) {
    // 🔥 ORDEM IMPORTA: Verifica billingType explícito primeiro
    if (appointment?.billingType === 'convenio') return 'insurance';
    if (appointment?.billingType === 'insurance') return 'insurance';
    if (appointment?.billingType === 'legal') return 'legal';
    if (appointment?.billingType === 'liminar') return 'legal';
    
    // Depois verifica package
    if (addToBalance) return 'particular';
    if (pkg) return 'package';
    return 'particular';
}

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
        isPaid: false,
        paymentStatus: 'pending',
        paymentOrigin,
        correlationId,
        visualFlag: 'pending',
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
        // 💰 NÃO assumimos pagamento — Payment é fonte de verdade
        update.$set.paymentStatus = 'pending';
        update.$set.visualFlag = 'pending';
    }
    
    return update;
}

export default { completeSessionEventDrivenV2 };
