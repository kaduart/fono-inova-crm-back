// services/appointmentCompleteService.js
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import PatientBalance from '../models/PatientBalance.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import crypto from 'crypto';

/**
 * Appointment Complete Service (HYBRID MODE)
 * 
 * AQUI é onde acontece a mágica no modo HYBRID:
 * - Atualiza Session para completed
 * - Consome pacote (se houver)
 * - Cria/atualiza Payment (se necessário)
 * - Atualiza Appointment
 * 
 * Compatível com fluxo legado E novo.
 */

export class AppointmentCompleteService {
    constructor() {
        this.Appointment = Appointment;
        this.Session = Session;
        this.Payment = Payment;
        this.Package = Package;
        this.PatientBalance = PatientBalance;
    }

    /**
     * Completa uma sessão/agendamento
     * 
     * @param {String} appointmentId - ID do agendamento
     * @param {Object} options - Opções (addToBalance, etc)
     * @param {mongoose.ClientSession} mongoSession - Sessão MongoDB
     * @returns {Object} Resultado
     */
    async complete(appointmentId, options = {}, mongoSession) {
        const { 
            addToBalance = false, 
            balanceAmount = 0,
            balanceDescription = '',
            userId = null
        } = options;

        // 1. Busca Appointment com relacionamentos
        const appointment = await this.Appointment.findById(appointmentId)
            .populate('session package patient doctor payment')
            .session(mongoSession);

        if (!appointment) {
            throw new Error('AGENDAMENTO_NAO_ENCONTRADO');
        }

        // 2. IDEMPOTÊNCIA: Verifica se já foi completado
        if (appointment.clinicalStatus === 'completed') {
            return {
                status: 'already_completed',
                appointmentId,
                message: 'Agendamento já foi completado anteriormente'
            };
        }

        // 3. Atualiza SESSION para completed
        let session = appointment.session;
        if (session) {
            await this.Session.findByIdAndUpdate(
                session._id,
                {
                    status: 'completed',
                    sessionConsumed: true,
                    completedAt: new Date(),
                    updatedAt: new Date()
                },
                { session: mongoSession }
            );
        }

        // 4. CONSOME PACOTE (se houver)
        let packageConsumed = false;
        if (appointment.package) {
            packageConsumed = await this.consumePackage(appointment.package._id, mongoSession);
        }

        // 5. PROCESSA PAGAMENTO (se necessário)
        let paymentResult = null;
        
        if (addToBalance) {
            // Adiciona ao saldo devedor
            paymentResult = await this.addToPatientBalance(appointment, balanceAmount, balanceDescription, userId);
        } else {
            // Processa pagamento normal
            paymentResult = await this.processPayment(appointment, mongoSession);
        }

        // 6. Atualiza APPOINTMENT
        const updateData = {
            operationalStatus: 'confirmed',
            clinicalStatus: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
            $push: {
                history: {
                    action: addToBalance ? 'completed_with_balance' : 'completed',
                    newStatus: 'completed',
                    changedBy: userId,
                    timestamp: new Date(),
                    context: addToBalance 
                        ? `Adicionado ao saldo: ${balanceAmount}` 
                        : `Sessão completada${packageConsumed ? ' - Pacote consumido' : ''}`
                }
            }
        };

        // Define paymentStatus
        if (addToBalance) {
            updateData.paymentStatus = 'pending';
            updateData.visualFlag = 'pending';
        } else if (appointment.package) {
            updateData.paymentStatus = 'package_paid';
            updateData.visualFlag = 'ok';
        } else if (paymentResult?.isPaid) {
            updateData.paymentStatus = 'paid';
            updateData.visualFlag = 'ok';
        }

        await this.Appointment.findByIdAndUpdate(appointmentId, updateData, { session: mongoSession });

        // 7. Publica eventos
        await this.publishCompletionEvents(appointment, paymentResult, mongoSession);

        return {
            status: 'completed',
            appointmentId,
            sessionId: session?._id?.toString(),
            packageConsumed,
            paymentResult,
            addToBalance
        };
    }

    /**
     * Consome sessão do pacote
     */
    async consumePackage(packageId, mongoSession) {
        const pkg = await this.Package.findById(packageId).session(mongoSession);
        
        if (!pkg) return false;

        const remaining = pkg.totalSessions - pkg.sessionsDone;
        
        if (remaining <= 0) {
            console.warn(`[CompleteService] Pacote ${packageId} sem crédito disponível`);
            return false;
        }

        await this.Package.findByIdAndUpdate(
            packageId,
            {
                $inc: { sessionsDone: 1 },
                updatedAt: new Date()
            },
            { session: mongoSession }
        );

        console.log(`[CompleteService] Pacote ${packageId} consumido: ${pkg.sessionsDone + 1}/${pkg.totalSessions}`);
        return true;
    }

    /**
     * Processa pagamento (se necessário)
     * 
     * Regras:
     * - Se já existe Payment e está paid: mantém
     * - Se existe Payment pending: atualiza para paid
     * - Se NÃO existe Payment (pacote/convênio): não cria agora
     * - Se particular sem payment: cria agora
     */
    async processPayment(appointment, mongoSession) {
        const { billingType, package: pkg, payment: existingPayment, sessionValue } = appointment;

        // CASO 1: Pacote ou Convênio - não cria payment aqui
        if (pkg || billingType === 'convenio') {
            return { 
                isPaid: !!pkg, 
                type: pkg ? 'package' : 'insurance',
                message: 'Sem pagamento direto' 
            };
        }

        // CASO 2: Já existe Payment
        if (existingPayment) {
            if (existingPayment.status === 'paid') {
                return { isPaid: true, paymentId: existingPayment._id, type: 'existing' };
            }

            // Atualiza para paid
            await this.Payment.findByIdAndUpdate(
                existingPayment._id,
                {
                    status: 'paid',
                    paidAt: new Date(),
                    confirmedAt: new Date()
                },
                { session: mongoSession }
            );

            return { isPaid: true, paymentId: existingPayment._id, type: 'updated' };
        }

        // CASO 3: Particular sem Payment - cria agora (HYBRID flexibility)
        if (billingType === 'particular' && sessionValue > 0) {
            const payment = new this.Payment({
                patient: appointment.patient?._id,
                doctor: appointment.doctor?._id,
                appointment: appointment._id,
                session: appointment.session?._id,
                amount: sessionValue,
                paymentMethod: appointment.paymentMethod || 'dinheiro',
                status: 'pending', // Aguarda recebimento
                billingType: 'particular',
                correlationId: appointment.correlationId,
                notes: `Gerado no complete do agendamento ${appointment._id}`
            });

            await payment.save({ session: mongoSession });

            await this.Appointment.findByIdAndUpdate(
                appointment._id,
                { payment: payment._id },
                { session: mongoSession }
            );

            return { isPaid: false, paymentId: payment._id, type: 'created_pending' };
        }

        return { isPaid: false, type: 'none', message: 'Sem valor a cobrar' };
    }

    /**
     * Adiciona ao saldo devedor do paciente
     */
    async addToPatientBalance(appointment, amount, description, userId) {
        const patientId = appointment.patient?._id;
        if (!patientId) return null;

        const balance = await this.PatientBalance.getOrCreate(patientId);
        
        await balance.addDebit(
            amount || appointment.sessionValue || 0,
            description || `Sessão ${appointment.date} - pagamento pendente`,
            appointment.session?._id,
            appointment._id,
            userId
        );

        return { isPaid: false, type: 'balance', balanceId: balance._id };
    }

    /**
     * Publica eventos de conclusão
     */
    async publishCompletionEvents(appointment, paymentResult, mongoSession) {
        const correlationId = appointment.correlationId;

        // Evento de sessão completada
        await saveToOutbox({
            eventId: crypto.randomUUID(),
            eventType: EventTypes.SESSION_COMPLETED,
            correlationId,
            payload: {
                appointmentId: appointment._id.toString(),
                sessionId: appointment.session?._id?.toString(),
                patientId: appointment.patient?._id?.toString(),
                packageConsumed: !!appointment.package,
                paymentStatus: paymentResult?.type
            },
            aggregateType: 'session',
            aggregateId: appointment.session?._id?.toString()
        }, mongoSession);

        // Notificação
        await publishEvent(EventTypes.NOTIFICATION_REQUESTED, {
            type: 'SESSION_COMPLETED',
            patientId: appointment.patient?._id?.toString(),
            appointmentId: appointment._id.toString(),
            channels: ['whatsapp']
        }, { correlationId, delay: 5000 });
    }
}

// Export singleton
export const appointmentCompleteService = new AppointmentCompleteService();
