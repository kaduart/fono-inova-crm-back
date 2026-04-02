// services/completeSessionEventService.js
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Convenio from '../models/Convenio.js';
import guideService from './billing/guideService.js';
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
 * 3. Processa pós-commit (Convênio / Liminar)
 * 4. Publica eventos (Payment, Balance, Sync)
 * 5. Retorna imediatamente
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

    // Guard para incremento de pacote
    const shouldIncrementPackage = packageId && appointment.clinicalStatus !== 'completed';

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
        if (packageId && shouldIncrementPackage) {
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
    // FASE 2.5: PROCESSAMENTO PÓS-COMMIT (CONVÊNIO / LIMINAR)
    // ============================================================
    const packageDoc = packageId ? await Package.findById(packageId).lean() : null;

    // ⚖️ LIMINAR
    if (packageId && packageDoc?.type === 'liminar' && shouldIncrementPackage) {
        try {
            const sessionRevenue = appointment.sessionValue || packageDoc.sessionValue || 0;

            await Package.updateOne(
                { _id: packageId },
                {
                    $inc: {
                        liminarCreditBalance: -sessionRevenue,
                        recognizedRevenue: sessionRevenue,
                        totalPaid: sessionRevenue
                    }
                }
            );

            const revenueDoc = await Payment.create({
                patient: patientId,
                doctor: doctorId,
                appointment: appointmentId,
                session: sessionId,
                package: packageId,
                amount: sessionRevenue,
                paymentMethod: 'liminar_credit',
                billingType: 'particular',
                status: 'paid',
                kind: 'revenue_recognition',
                serviceDate: appointment.date,
                paymentDate: appointment.date,
                notes: `Receita reconhecida - Processo: ${packageDoc.liminarProcessNumber || 'N/A'}`,
                paymentOrigin: 'liminar',
                correlationId
            });

            await Appointment.updateOne(
                { _id: appointmentId },
                { $set: { payment: revenueDoc._id, paymentStatus: 'package_paid' } }
            );

            console.log(`[CompleteSession] ✅ Receita liminar reconhecida: R$ ${sessionRevenue}`);
        } catch (err) {
            console.error(`[CompleteSession] ❌ Erro liminar pós-commit:`, err.message);
        }
    }

    // 🏥 CONVÊNIO
    if (packageId && packageDoc?.type === 'convenio') {
        try {
            if (packageDoc?.insuranceGuide) {
                await guideService.consumeGuideSession(packageDoc.insuranceGuide);
            }

            const guide = packageDoc?.insuranceGuide ? await InsuranceGuide.findById(packageDoc.insuranceGuide) : null;
            const convenioValue = await Convenio.getSessionValue(packageDoc.insuranceProvider) || 0;

            const newPayment = await Payment.create({
                patient: patientId,
                doctor: doctorId,
                appointment: appointmentId,
                session: sessionId,
                package: packageId,
                amount: 0,
                billingType: 'convenio',
                insuranceProvider: packageDoc.insuranceProvider,
                insuranceValue: convenioValue,
                paymentMethod: 'convenio',
                status: 'pending',
                kind: 'manual',
                insurance: {
                    provider: packageDoc.insuranceProvider,
                    grossAmount: convenioValue,
                    authorizationCode: guide?.authorizationCode || null,
                    status: 'pending_billing'
                },
                serviceDate: appointment.date,
                notes: `Sessão de convênio - Guia ${guide?.number || 'N/A'} - Pacote ${packageId}`,
                paymentOrigin: 'convenio',
                correlationId
            });

            await Appointment.updateOne(
                { _id: appointmentId },
                { $set: { payment: newPayment._id } }
            );

            if (sessionId) {
                await Session.findByIdAndUpdate(sessionId, { $set: { paymentId: newPayment._id } });
            }

            if (convenioValue > 0) {
                await Package.updateOne(
                    { _id: packageId },
                    {
                        $set: {
                            insuranceGrossAmount: convenioValue,
                            sessionValue: convenioValue
                        }
                    }
                );
            }

            console.log(`[CompleteSession] ✅ Payment convênio criado: ${newPayment._id}`);
        } catch (err) {
            console.error(`[CompleteSession] ❌ Erro convênio pós-commit:`, err.message);
        }
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
            paymentOrigin
        }
    });

    // Evento 2: Payment Requested (resolve o "gap")
    // Só cria pagamento se não for saldo devedor, convênio ou liminar (já criado no pós-commit)
    if (!addToBalance && paymentOrigin !== 'manual_balance' && paymentOrigin !== 'convenio' && paymentOrigin !== 'liminar') {
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
        } else if (appointment.package?.type === 'liminar') {
            update.$set.paymentStatus = 'package_paid';
            update.$set.visualFlag = 'ok';
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
