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
import { resolveSessionType } from '../utils/sessionTypeResolver.js';
import { withFinancialContext } from '../utils/financialContext.js';
import * as LedgerService from './financialLedgerService.js';
import { dashboardCache } from './adminDashboardCacheService.js';

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
    async complete(appointmentId, options = {}, mongoSession = null) {
        // 🔒 CONTEXTO FINANCEIRO: Toda operação roda dentro do contexto 'payment'
        // 🔥 OTIMIZAÇÃO: Se mongoSession é null, executa sem transaction (mais rápido)
        return withFinancialContext('payment', async () => {
            return this._completeInternal(appointmentId, options, mongoSession);
        });
    }
    
    async _completeInternal(appointmentId, options = {}, mongoSession) {
        const startTime = Date.now();
        
        const { 
            addToBalance = false, 
            balanceAmount = 0,
            balanceDescription = '',
            userId = null
        } = options;

        // 🔥 OTIMIZAÇÃO: Busca APENAS o necessário (sem populate pesado)
        const appointment = await this.Appointment.findById(appointmentId)
            .select('session package patient doctor payment sessionValue serviceType date time clinicId specialty correlationId clinicalStatus operationalStatus')
            .lean();

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

        // 🔥 PASSO 1: ESSENCIAL (responde em <300ms)
        // ===========================================
        
        // 3. Atualiza SESSION para completed
        let sessionId = appointment.session;
        const isPackagePrepaid = !!appointment.package;
        
        if (sessionId) {
            await this.Session.findByIdAndUpdate(sessionId, {
                status: 'completed',
                clinicalStatus: 'completed',
                sessionConsumed: true,
                completedAt: new Date(),
                updatedAt: new Date(),
                ...(isPackagePrepaid && {
                    paymentStatus: 'paid',
                    isPaid: true,
                    visualFlag: 'ok',
                    paidAt: new Date(),
                    paymentOrigin: 'package_prepaid'
                })
            });
        }

        // 4. CONSOME PACOTE (se houver)
        let packageConsumed = false;
        if (appointment.package) {
            await this.Package.findByIdAndUpdate(appointment.package, {
                $inc: { sessionsDone: 1 }
            });
            packageConsumed = true;
        }

        // 5. Atualiza APPOINTMENT (essencial)
        const correlationId = appointment.correlationId || crypto.randomUUID();
        const finalSessionValue = appointment.sessionValue || 150;
        
        await this.Appointment.findByIdAndUpdate(appointmentId, {
            operationalStatus: 'confirmed',
            clinicalStatus: 'completed',
            sessionValue: finalSessionValue,
            completedAt: new Date(),
            updatedAt: new Date(),
            correlationId,
            paymentStatus: isPackagePrepaid ? 'package_paid' : 'pending',
            visualFlag: isPackagePrepaid ? 'ok' : 'pending',
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
        });

        // 🔥 PASSO 2: BACKGROUND (não bloqueia resposta)
        // ===========================================
        setImmediate(async () => {
            try {
                // Processa pagamento (se necessário)
                let paymentResult = null;
                if (addToBalance) {
                    paymentResult = await this.addToPatientBalance(
                        appointment, balanceAmount, balanceDescription, userId, correlationId
                    );
                } else if (!isPackagePrepaid) {
                    paymentResult = await this.processPayment(appointment, null, correlationId);
                }

                // Ledger (auditoria)
                const financialStatus = this.resolveFinancialStatus(appointment, paymentResult, addToBalance);
                await this.recordLedgerEntry(appointment, financialStatus, paymentResult, correlationId, userId, null);

                // Eventos
                await this.publishCompletionEvents(appointment, paymentResult, correlationId);

                // Dashboard cache
                await dashboardCache.incrementOverview({
                    'sessions.today': 1,
                    'revenue.month': finalSessionValue
                });

                console.log(`[CompleteService] ✅ Background tasks done (${Date.now() - startTime}ms)`);
            } catch (err) {
                console.error(`[CompleteService] ⚠️ Background erro:`, err.message);
            }
        });

        console.log(`[CompleteService] ⚡ Essential done in ${Date.now() - startTime}ms`);

        return {
            status: 'completed',
            appointmentId,
            sessionId: sessionId?.toString(),
            packageConsumed,
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
    async processPayment(appointment, mongoSession, correlationId) {
        const { billingType, package: pkg, payment: existingPayment, sessionValue, _id: appointmentId } = appointment;

        // CASO 1: Pacote ou Convênio - não cria payment aqui
        if (pkg || billingType === 'convenio') {
            return { 
                isPaid: !!pkg, 
                type: pkg ? 'package' : 'insurance',
                message: 'Sem pagamento direto' 
            };
        }
        
        // 🔒 IDEMPOTÊNCIA: Verifica se já existe payment para esse appointment
        // (proteção contra duplicação em retry/race condition)
        if (!existingPayment && appointmentId) {
            const existingPaymentFromDB = await this.Payment.findOne({
                appointment: appointmentId,
                status: { $in: ['paid', 'pending'] }
            }).session(mongoSession);
            
            if (existingPaymentFromDB) {
                console.log(`[CompleteService] Payment idempotente encontrado: ${existingPaymentFromDB._id}`);
                
                if (existingPaymentFromDB.status === 'paid') {
                    return { 
                        isPaid: true, 
                        paymentId: existingPaymentFromDB._id, 
                        type: 'existing_paid' 
                    };
                }
                
                // Atualiza para paid se estava pending
                await this.Payment.findByIdAndUpdate(
                    existingPaymentFromDB._id,
                    {
                        status: 'paid',
                        paidAt: new Date(),
                        confirmedAt: new Date(),
                        correlationId
                    },
                    { session: mongoSession }
                );
                
                return { 
                    isPaid: true, 
                    paymentId: existingPaymentFromDB._id, 
                    type: 'updated_to_paid' 
                };
            }
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
            const paymentData = {
                patient: appointment.patient?._id,
                doctor: appointment.doctor?._id,
                appointment: appointment._id,
                session: appointment.session?._id,
                amount: sessionValue,
                paymentMethod: appointment.paymentMethod || 'dinheiro',
                status: 'pending',
                billingType: 'particular',
                correlationId: correlationId || crypto.randomUUID(),
                notes: `Gerado no complete do agendamento ${appointment._id}`,
                paymentDate: new Date() // 🔒 required pelo schema
            };
            
            // 🔒 ATOMICIDADE: Cria Payment + Evento na mesma transaction
            const payment = await this.Payment.createWithEvent(
                paymentData,
                {
                    eventType: 'PAYMENT_CREATED',
                    correlationId,
                    payload: {
                        source: 'appointment_complete',
                        sessionValue,
                        pending: true
                    }
                },
                mongoSession
            );

            await this.Appointment.findByIdAndUpdate(
                appointment._id,
                { payment: payment._id },
                { session: mongoSession }
            );

            return { isPaid: false, paymentId: payment._id, type: 'auto_per_session' };
        }

        return { isPaid: false, type: 'none', message: 'Sem valor a cobrar' };
    }

    /**
     * Adiciona ao saldo devedor do paciente
     */
    async addToPatientBalance(appointment, amount, description, userId, correlationId) {
        const patientId = appointment.patient?._id;
        if (!patientId) return null;

        const balance = await this.PatientBalance.getOrCreate(patientId);
        
        // 🆕 MAPEAMENTO: Converte service types específicos para especialidades
        let normalizedSpecialty = appointment.specialty;
        const specialtyMap = {
            'tongue_tie_test': 'fonoaudiologia',
            'neuropsych_evaluation': 'psicologia',
            'evaluation': appointment.specialty || 'fonoaudiologia'
        };
        
        if (appointment.serviceType && specialtyMap[appointment.serviceType]) {
            normalizedSpecialty = specialtyMap[appointment.serviceType];
        }
        
        await balance.addDebit(
            amount || appointment.sessionValue || 0,
            description || `Sessão ${appointment.date} - pagamento pendente`,
            appointment.session?._id,
            appointment._id,
            userId,
            normalizedSpecialty,  // 🆕 ESPECIALIDADE MAPEADA
            correlationId || appointment.correlationId || crypto.randomUUID()  // 🆕 V4: correlationId para idempotência
        );

        return { isPaid: false, type: 'balance', balanceId: balance._id };
    }

    /**
     * Publica eventos de conclusão
     */
    async publishCompletionEvents(appointment, paymentResult, mongoSession) {
        // 🔧 GARANTIR correlationId (gera se não existir)
        const correlationId = appointment.correlationId || crypto.randomUUID();

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
            aggregateId: appointment.session?._id?.toString() || appointment._id.toString()
        }, mongoSession);

        // Notificação
        await publishEvent(EventTypes.NOTIFICATION_REQUESTED, {
            type: 'SESSION_COMPLETED',
            patientId: appointment.patient?._id?.toString(),
            appointmentId: appointment._id.toString(),
            channels: ['whatsapp']
        }, { correlationId, delay: 5000 });
    }

    /**
     * ⚡ SCHEDULE: Agenda publicação de eventos em background
     * 
     * 🔥 CRITICAL: Isso garante resposta HTTP instantânea (<500ms)
     * enquanto eventos são processados depois.
     * 
     * NÃO usa await - é fire-and-forget proposital.
     */
    scheduleEventPublishing(eventData) {
        const { appointment, paymentResult, correlationId } = eventData;
        
        // 🔥 Joga pro próximo ciclo do event loop - não bloqueia request
        setImmediate(async () => {
            try {
                console.log(`[CompleteService] 🔄 Publicando eventos em background (correlationId: ${correlationId})`);
                
                // Recria appointment com dados mínimos necessários
                const minimalAppointment = {
                    _id: appointment._id,
                    session: appointment.session,
                    patient: appointment.patient,
                    package: appointment.package,
                    correlationId
                };
                
                await this.publishCompletionEvents(minimalAppointment, paymentResult, null);
                
                console.log(`[CompleteService] ✅ Eventos publicados (correlationId: ${correlationId})`);
            } catch (err) {
                // 🔥 Erro em evento não quebra o fluxo - apenas loga
                console.error(`[CompleteService] ⚠️ Erro ao publicar eventos (não crítico):`, err.message);
            }
        });
    }
}

// Export singleton
export const appointmentCompleteService = new AppointmentCompleteService();
