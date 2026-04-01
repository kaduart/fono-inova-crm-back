// services/appointmentHybridService.js
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import crypto from 'crypto';

/**
 * Appointment Hybrid Service
 * 
 * MODO HYBRID:
 * - Cria Appointment + Session (sempre)
 * - Payment depende do cenário:
 *   * PARTICULAR: cria Payment pendente
 *   * PACOTE: verifica crédito e estado de pagamento do pacote
 *   * CONVÊNIO: não cria (fatura depois)
 */

export class AppointmentHybridService {
    constructor() {
        this.Appointment = Appointment;
        this.Session = Session;
        this.Payment = Payment;
        this.Package = Package;
    }

    /**
     * Cria agendamento no modo HYBRID
     */
    async create(data, mongoSession) {
        const {
            patientId,
            doctorId,
            date,
            time,
            specialty = 'fonoaudiologia',
            serviceType = 'session',
            packageId = null,
            insuranceGuideId = null,
            billingType = 'particular',
            paymentMethod = 'dinheiro',
            amount = 0,
            forcePayment = false, // Força criação de payment (ex: upgrade de pacote)
            notes = '',
            userId = null
        } = data;

        // 0. Se tem pacote, busca informações dele
        let packageInfo = null;
        if (packageId) {
            packageInfo = await this.Package.findById(packageId).session(mongoSession);
        }

        // Determina estratégia de pagamento
        const paymentStrategy = this.determinePaymentStrategy({
            billingType,
            packageId,
            packageInfo,
            insuranceGuideId,
            amount,
            forcePayment
        });

        // 1. Cria APPOINTMENT
        const appointment = new this.Appointment({
            patient: patientId,
            doctor: doctorId,
            date,
            time,
            specialty,
            serviceType,
            package: packageId,
            insuranceGuide: insuranceGuideId,
            
            // Status
            operationalStatus: 'pending',
            clinicalStatus: 'pending',
            paymentStatus: paymentStrategy.appointmentPaymentStatus,
            
            // Dados financeiros
            sessionValue: amount,
            paymentMethod,
            billingType,
            
            // Metadados
            notes,
            correlationId: crypto.randomUUID(),
            createdBy: userId,
            
            // Histórico
            history: [{
                action: 'appointment_requested',
                newStatus: 'pending',
                changedBy: userId,
                timestamp: new Date(),
                context: `Criação HYBRID: ${serviceType} | ${paymentStrategy.reason}`
            }]
        });

        await appointment.save({ session: mongoSession });

        // 2. Cria SESSION (sempre)
        const session = new this.Session({
            patient: patientId,
            doctor: doctorId,
            package: packageId,
            appointmentId: appointment._id,
            date,
            time,
            sessionType: specialty,
            sessionValue: amount,
            status: 'scheduled',
            isPaid: paymentStrategy.isPrepaid,
            paymentStatus: paymentStrategy.sessionPaymentStatus,
            paymentOrigin: paymentStrategy.paymentOrigin,
            visualFlag: paymentStrategy.visualFlag,
            correlationId: appointment.correlationId
        });

        await session.save({ session: mongoSession });

        // Vincula Session
        appointment.session = session._id;
        await appointment.save({ session: mongoSession });

        // 3. Cria PAYMENT (se necessário)
        let payment = null;
        if (paymentStrategy.shouldCreatePayment) {
            payment = new this.Payment({
                patient: patientId,
                doctor: doctorId,
                appointment: appointment._id,
                session: session._id,
                package: packageId,
                amount: paymentStrategy.paymentAmount,
                paymentMethod,
                status: paymentStrategy.paymentStatus,
                serviceType,
                billingType,
                correlationId: appointment.correlationId,
                notes: paymentStrategy.paymentNotes
            });

            await payment.save({ session: mongoSession });
            appointment.payment = payment._id;
            await appointment.save({ session: mongoSession });
        }

        // 4. Salva evento no Outbox
        await saveToOutbox({
            eventId: crypto.randomUUID(),
            eventType: 'APPOINTMENT_CREATED',
            correlationId: appointment.correlationId,
            payload: {
                appointmentId: appointment._id.toString(),
                sessionId: session._id.toString(),
                paymentId: payment?._id?.toString(),
                patientId: patientId?.toString(),
                doctorId: doctorId?.toString(),
                packageId: packageId?.toString(),
                billingType,
                amount,
                paymentStrategy: paymentStrategy.type,
                hasPayment: !!payment
            },
            aggregateType: 'appointment',
            aggregateId: appointment._id.toString()
        }, mongoSession);

        console.log(`[HybridService] Criado:`, {
            appointmentId: appointment._id,
            sessionId: session._id,
            paymentId: payment?._id || null,
            strategy: paymentStrategy.type,
            reason: paymentStrategy.reason
        });

        return {
            appointmentId: appointment._id.toString(),
            sessionId: session._id.toString(),
            paymentId: payment?._id?.toString() || null,
            correlationId: appointment.correlationId,
            status: 'pending',
            billingType,
            paymentStrategy: paymentStrategy.type,
            hasPayment: !!payment,
            message: paymentStrategy.message
        };
    }

    /**
     * Determina a estratégia de pagamento com base no cenário
     * 
     * CENÁRIOS DE PACOTE:
     * 1. Pacote pago + tem crédito → usa crédito (sem payment)
     * 2. Pacote pago + sem crédito → paga avulso (com payment)
     * 3. Pacote parcelado → pode pagar parcela agora (com payment)
     * 4. Pacote pendente → depende (pode cobrar agora ou deixar)
     * 5. Upgrade/forçado → sempre cobra (com payment)
     */
    determinePaymentStrategy({ billingType, packageId, packageInfo, insuranceGuideId, amount, forcePayment }) {
        
        // CASO 1: Convênio
        if (billingType === 'convenio' || insuranceGuideId) {
            return {
                type: 'insurance',
                shouldCreatePayment: false,
                isPrepaid: false,
                appointmentPaymentStatus: 'pending_receipt',
                sessionPaymentStatus: 'pending',
                paymentOrigin: 'convenio',
                visualFlag: 'pending',
                paymentAmount: amount,
                paymentStatus: null,
                reason: 'Convênio - faturamento posterior',
                message: 'Agendamento convênio criado (sem pagamento imediato)',
                paymentNotes: null
            };
        }

        // CASO 2: Particular sem pacote
        if (!packageId && billingType === 'particular') {
            const shouldPay = amount > 0;
            return {
                type: 'particular_direct',
                shouldCreatePayment: shouldPay,
                isPrepaid: false,
                appointmentPaymentStatus: shouldPay ? 'pending' : 'pending',
                sessionPaymentStatus: 'pending',
                paymentOrigin: 'individual',
                visualFlag: shouldPay ? 'blocked' : 'ok',
                paymentAmount: amount,
                paymentStatus: 'pending',
                reason: shouldPay ? 'Particular - pagamento pendente' : 'Particular - valor zero',
                message: shouldPay 
                    ? 'Agendamento criado com pagamento pendente'
                    : 'Agendamento criado (valor zero)',
                paymentNotes: shouldPay ? `Pagamento referente à sessão` : null
            };
        }

        // CASO 3: Pacote
        if (packageId && packageInfo) {
            const remainingSessions = packageInfo.totalSessions - (packageInfo.sessionsDone || 0);
            const packagePaid = packageInfo.paymentStatus === 'paid' || 
                               packageInfo.paidAmount >= packageInfo.totalValue;
            const packagePartial = packageInfo.paymentStatus === 'partial' || 
                                  (packageInfo.paidAmount > 0 && packageInfo.paidAmount < packageInfo.totalValue);

            // 3A: Forçar pagamento (upgrade, diferença, etc)
            if (forcePayment && amount > 0) {
                return {
                    type: 'package_forced_payment',
                    shouldCreatePayment: true,
                    isPrepaid: false,
                    appointmentPaymentStatus: 'pending',
                    sessionPaymentStatus: 'pending',
                    paymentOrigin: 'individual', // Pagamento avulso
                    visualFlag: 'blocked',
                    paymentAmount: amount,
                    paymentStatus: 'pending',
                    reason: 'Pacote - pagamento forçado (upgrade/diferença)',
                    message: 'Agendamento criado com pagamento adicional',
                    paymentNotes: `Pagamento adicional ao pacote ${packageId}`
                };
            }

            // 3B: Pacote pago + tem crédito → usa crédito
            if (packagePaid && remainingSessions > 0) {
                return {
                    type: 'package_prepaid',
                    shouldCreatePayment: false,
                    isPrepaid: true,
                    appointmentPaymentStatus: 'package_paid',
                    sessionPaymentStatus: 'package_paid',
                    paymentOrigin: 'package_prepaid',
                    visualFlag: 'ok',
                    paymentAmount: 0,
                    paymentStatus: null,
                    reason: `Pacote pago - ${remainingSessions} créditos disponíveis`,
                    message: 'Agendamento criado usando crédito do pacote',
                    paymentNotes: null
                };
            }

            // 3C: Pacote pago + sem crédito → paga avulso
            if (packagePaid && remainingSessions <= 0) {
                const shouldPay = amount > 0;
                return {
                    type: 'package_exhausted',
                    shouldCreatePayment: shouldPay,
                    isPrepaid: false,
                    appointmentPaymentStatus: shouldPay ? 'pending' : 'pending',
                    sessionPaymentStatus: shouldPay ? 'pending' : 'package_paid',
                    paymentOrigin: shouldPay ? 'individual' : 'package_prepaid',
                    visualFlag: shouldPay ? 'blocked' : 'ok',
                    paymentAmount: amount,
                    paymentStatus: shouldPay ? 'pending' : null,
                    reason: 'Pacote esgotado - pagamento avulso necessário',
                    message: shouldPay 
                        ? 'Pacote sem créditos - pagamento avulso pendente'
                        : 'Pacote sem créditos - sessão sem custo',
                    paymentNotes: shouldPay ? 'Pagamento avulso (pacote esgotado)' : null
                };
            }

            // 3D: Pacote parcelado (parcialmente pago)
            if (packagePartial && remainingSessions > 0) {
                // Aqui tem opção: pode cobrar agora ou confiar que vai pagar depois
                // Por padrão, permite usar o crédito mas marca como pendente
                return {
                    type: 'package_partial',
                    shouldCreatePayment: false, // Não cobra agora, cobra no fechamento
                    isPrepaid: true, // Considera pré-pago para usar sessão
                    appointmentPaymentStatus: 'partial',
                    sessionPaymentStatus: 'package_paid', // Libera sessão
                    paymentOrigin: 'package_prepaid',
                    visualFlag: 'pending', // Amarelo - atenção
                    paymentAmount: 0,
                    paymentStatus: null,
                    reason: `Pacote parcelado - ${remainingSessions} créditos, ${packageInfo.paidAmount}/${packageInfo.totalValue} pago`,
                    message: 'Agendamento criado (pacote parcelado - quitção pendente)',
                    paymentNotes: null
                };
            }

            // 3E: Pacote não pago (pendente)
            if (!packagePaid && !packagePartial) {
                return {
                    type: 'package_unpaid',
                    shouldCreatePayment: false, // Não cria automaticamente
                    isPrepaid: false,
                    appointmentPaymentStatus: 'pending',
                    sessionPaymentStatus: 'pending',
                    paymentOrigin: 'package_prepaid',
                    visualFlag: 'blocked',
                    paymentAmount: 0,
                    paymentStatus: null,
                    reason: 'Pacote não pago - aguardando pagamento',
                    message: 'Agendamento criado (pacote não pago - sessão bloqueada)',
                    paymentNotes: null
                };
            }
        }

        // CASO 4: Pacote não encontrado (trata como particular)
        if (packageId && !packageInfo) {
            console.warn(`[HybridService] Pacote ${packageId} não encontrado, tratando como particular`);
            return {
                type: 'package_not_found_fallback',
                shouldCreatePayment: amount > 0,
                isPrepaid: false,
                appointmentPaymentStatus: 'pending',
                sessionPaymentStatus: 'pending',
                paymentOrigin: 'individual',
                visualFlag: 'blocked',
                paymentAmount: amount,
                paymentStatus: 'pending',
                reason: 'Pacote não encontrado - fallback para particular',
                message: 'Agendamento criado (pacote inválido - tratado como particular)',
                paymentNotes: 'Pacote não encontrado no sistema'
            };
        }

        // Fallback genérico
        return {
            type: 'unknown',
            shouldCreatePayment: false,
            isPrepaid: false,
            appointmentPaymentStatus: 'pending',
            sessionPaymentStatus: 'pending',
            paymentOrigin: 'unknown',
            visualFlag: 'pending',
            paymentAmount: 0,
            paymentStatus: null,
            reason: 'Cenário não identificado',
            message: 'Agendamento criado (configuração incompleta)',
            paymentNotes: null
        };
    }
}

export const appointmentHybridService = new AppointmentHybridService();
