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
        // 🔥 OTIMIZAÇÃO: Sem contexto financeiro no complete (vai pro background)
        // Isso remove qualquer lock/tracing síncrono
        return this._completeInternal(appointmentId, options, mongoSession);
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
            .select('session package patient doctor payment sessionValue serviceType date time clinicId specialty correlationId clinicalStatus operationalStatus billingType')
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

        // 🔥 PASSO 1: ESSENCIAL (responde em <100ms)
        // ===========================================
        
        let sessionId = appointment.session;
        const isPackagePrepaid = !!appointment.package;
        const correlationId = appointment.correlationId || crypto.randomUUID();
        const finalSessionValue = appointment.sessionValue || 150;
        const isParticular = !isPackagePrepaid && !addToBalance && appointment.billingType === 'particular';
        
        // 🔥 OTIMIZAÇÃO: Roda updates em PARALELO (Promise.all)
        const essentialUpdates = [];
        
        // 3. Atualiza SESSION (se existir)
        if (sessionId) {
            essentialUpdates.push(
                this.Session.findByIdAndUpdate(sessionId, {
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
                })
            );
        }
        
        // 4. Atualiza APPOINTMENT (sempre)
        essentialUpdates.push(
            this.Appointment.findByIdAndUpdate(appointmentId, {
                operationalStatus: 'confirmed',
                clinicalStatus: 'completed',
                sessionValue: finalSessionValue,
                completedAt: new Date(),
                updatedAt: new Date(),
                correlationId,
                paymentStatus: isPackagePrepaid ? 'package_paid' : (isParticular ? 'paid' : 'pending'),
                visualFlag: isPackagePrepaid ? 'ok' : (isParticular ? 'ok' : 'pending'),
                $push: {
                    history: {
                        action: addToBalance ? 'completed_with_balance' : 'completed',
                        newStatus: 'completed',
                        changedBy: userId,
                        timestamp: new Date(),
                        context: addToBalance 
                            ? `Adicionado ao saldo: ${balanceAmount}` 
                            : 'Sessão completada'
                    }
                }
            })
        );
        
        // Roda tudo em paralelo
        await Promise.all(essentialUpdates);
        
        // 5. PACOTE vai pro background (não bloqueia resposta)
        let packageConsumed = !!appointment.package;

        // 🔥 PASSO 2: BACKGROUND (não bloqueia resposta)
        // ===========================================
        setImmediate(async () => {
            try {
                // 5. CONSOME PACOTE (agora em background)
                if (appointment.package) {
                    await this.Package.findByIdAndUpdate(appointment.package, {
                        $inc: { sessionsDone: 1 }
                    });
                    console.log(`[CompleteService] Package consumed [${appointmentId}]`);
                }
                
                // Processa pagamento (se necessário)
                let paymentResult = null;
                if (addToBalance) {
                    paymentResult = await this.addToPatientBalance(
                        appointment, balanceAmount, balanceDescription, userId, correlationId
                    );
                    console.log(`[CompleteService] Balance added [${appointmentId}]:`, paymentResult);
                } else if (!isPackagePrepaid) {
                    paymentResult = await this.processPayment(appointment, null, correlationId);
                    console.log(`[CompleteService] Payment processed [${appointmentId}]:`, paymentResult);
                } else {
                    console.log(`[CompleteService] No payment needed [${appointmentId}] - package or addToBalance`);
                }

                // Ledger (auditoria) - com retry implícito
                try {
                    const financialStatus = this.resolveFinancialStatus(appointment, paymentResult, addToBalance);
                    await this.recordLedgerEntry(appointment, financialStatus, paymentResult, correlationId, userId, null);
                } catch (ledgerErr) {
                    console.error(`[CompleteService] ⚠️ Ledger erro (não crítico):`, ledgerErr.message);
                }

                // Sincroniza Appointment com status do Payment
                if (paymentResult?.isPaid && paymentResult.paymentId) {
                    await this.Appointment.findByIdAndUpdate(appointmentId, {
                        paymentStatus: 'paid',
                        visualFlag: 'ok',
                        payment: paymentResult.paymentId,
                        updatedAt: new Date()
                    });
                    console.log(`[CompleteService] Appointment synced to paid [${appointmentId}]`);
                }

                // Eventos
                await this.publishCompletionEvents(appointment, paymentResult, correlationId);

                // Dashboard cache (não bloqueia se falhar)
                try {
                    await dashboardCache.incrementOverview({
                        'sessions.today': 1,
                        'revenue.month': finalSessionValue
                    });
                } catch (dashErr) {
                    console.error(`[CompleteService] ⚠️ Dashboard erro (não crítico):`, dashErr.message);
                }

                console.log(`[CompleteService] ✅ Background done (${Date.now() - startTime}ms)`);
            } catch (err) {
                console.error(`[CompleteService] ⚠️ Background erro [${appointmentId}]:`, err.message);
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

        // CASO 3: Particular sem Payment - cria como PAID imediatamente
        if (billingType === 'particular' && sessionValue > 0) {
            const paymentData = {
                patient: appointment.patient?._id,
                doctor: appointment.doctor?._id,
                appointment: appointment._id,
                session: appointment.session?._id,
                amount: sessionValue,
                paymentMethod: appointment.paymentMethod || 'dinheiro',
                status: 'paid',  // ✅ Pago imediatamente no complete
                paidAt: new Date(),  // 🔒 Obrigatório quando status='paid'
                billingType: 'particular',
                correlationId: correlationId || crypto.randomUUID(),
                notes: `Pago no complete do agendamento ${appointment._id}`,
                paymentDate: new Date()
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
                        paid: true
                    }
                },
                mongoSession
            );

            await this.Appointment.findByIdAndUpdate(
                appointment._id,
                { payment: payment._id },
                { session: mongoSession }
            );

            return { isPaid: true, paymentId: payment._id, type: 'auto_per_session' };
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
    
    /**
     * Resolve status financeiro para o ledger
     */
    resolveFinancialStatus(appointment, paymentResult, addToBalance) {
        if (addToBalance) return 'balance_pending';
        if (appointment.package) return 'package_prepaid';
        if (paymentResult?.isPaid) return 'paid';
        return 'pending';
    }
    
    /**
     * Registra entrada no ledger (auditoria)
     */
    async recordLedgerEntry(appointment, financialStatus, paymentResult, correlationId, userId, session) {
        const { recordSessionRevenue, recordPaymentReceived, recordPaymentPending } = LedgerService;
        const billingType = appointment.billingType || 'particular';
        const sessionValue = appointment.sessionValue || 0;

        // 1. Sempre reconhece receita da sessão
        if (sessionValue > 0) {
            const sessionForLedger = session || {
                _id: appointment.session,
                patient: appointment.patient,
                appointmentId: appointment._id,
                sessionValue,
                paymentMethod: appointment.paymentMethod,
                sessionType: appointment.sessionType,
                insuranceGuide: appointment.insuranceGuide,
                correlationId
            };
            await recordSessionRevenue(sessionForLedger, { userId, correlationId });
        }

        // 2. Se houve pagamento, registra entrada de caixa
        if (paymentResult?.payment && paymentResult.payment.status === 'paid') {
            await recordPaymentReceived(paymentResult.payment, { userId, correlationId });
        }

        // 3. Se ficou fiado (addToBalance), registra a receber
        if (financialStatus === 'pending' && sessionValue > 0) {
            await recordPaymentPending(
                { amount: sessionValue, patient: appointment.patient, appointment: appointment._id, correlationId },
                { userId, correlationId }
            );
        }

        console.log(`[CompleteService] Ledger recorded [${appointment._id}]: ${financialStatus}`);
    }
}

// Export singleton
export const appointmentCompleteService = new AppointmentCompleteService();
