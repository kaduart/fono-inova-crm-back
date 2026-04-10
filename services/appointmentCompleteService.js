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
        const perf = { step: '', time: 0 };
        
        const { 
            addToBalance = false, 
            balanceAmount = 0,
            balanceDescription = '',
            userId = null
        } = options;

        // 1. Busca Appointment com relacionamentos
        const t1 = Date.now();
        const appointment = await this.Appointment.findById(appointmentId)
            .populate('session package patient doctor payment')
            .session(mongoSession);
        perf.step = 'find_appointment';
        perf.time = Date.now() - t1;
        if (perf.time > 100) console.log(`[PERF] ${perf.step}: ${perf.time}ms`);

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
        const isPackagePrepaid = !!appointment.package;
        
        if (session) {
            const sessionUpdate = {
                status: 'completed',
                clinicalStatus: 'completed',
                sessionConsumed: true,
                completedAt: new Date(),
                updatedAt: new Date()
            };
            
            // 🔧 PACOTE PRÉ-PAGO: Session já está paga
            if (isPackagePrepaid) {
                sessionUpdate.paymentStatus = 'paid';
                sessionUpdate.isPaid = true;
                sessionUpdate.visualFlag = 'ok';
                sessionUpdate.paidAt = new Date();
                sessionUpdate.paymentOrigin = 'package_prepaid';
            }
            
            await this.Session.findByIdAndUpdate(
                session._id,
                sessionUpdate,
                { session: mongoSession }
            );
        } else if (isPackagePrepaid) {
            // Cria session para pacote pré-pago se não existir
            const newSession = await this.Session.create([{
                patient: appointment.patient?._id,
                patientId: appointment.patient?._id,
                doctor: appointment.doctor?._id,
                doctorId: appointment.doctor?._id,
                appointment: appointment._id,
                appointmentId: appointment._id,
                date: appointment.date,
                time: appointment.time,
                status: 'completed',
                clinicalStatus: 'completed',
                sessionType: resolveSessionType(appointment),
                clinicId: appointment.clinicId || 'default',
                completedAt: new Date(),
                paymentStatus: 'paid',
                isPaid: true,
                visualFlag: 'ok',
                paidAt: new Date(),
                paymentOrigin: 'package_prepaid',
                notes: 'Sessão criada via complete de pacote pré-pago'
            }], { session: mongoSession });
            
            appointment.session = newSession[0]._id;
            appointment.sessionId = newSession[0]._id;
            console.log(`[CompleteService] Session ${newSession[0]._id} criada para pacote pré-pago`);
        }

        // 4. CONSOME PACOTE (se houver)
        let packageConsumed = false;
        if (appointment.package) {
            packageConsumed = await this.consumePackage(appointment.package._id, mongoSession);
        }

        // 5. PROCESSA PAGAMENTO (se necessário)
        let paymentResult = null;
        
        // 🔧 GARANTIR correlationId para payment e outbox
        const correlationId = appointment.correlationId || crypto.randomUUID();
        
        if (addToBalance) {
            // Adiciona ao saldo devedor
            paymentResult = await this.addToPatientBalance(appointment, balanceAmount, balanceDescription, userId, correlationId);
        } else {
            // Processa pagamento normal
            paymentResult = await this.processPayment(appointment, mongoSession, correlationId);
        }

        // 6. Atualiza APPOINTMENT
        // Garantir que sessionValue tenha um valor válido
        let finalSessionValue = appointment.sessionValue;
        if (!finalSessionValue || finalSessionValue <= 0) {
            // Tentar obter do pacote
            if (appointment.package?.sessionValue > 0) {
                finalSessionValue = appointment.package.sessionValue;
            }
            // Tentar obter do pagamento
            else if (appointment.payment?.amount > 0) {
                finalSessionValue = appointment.payment.amount;
            }
            // Fallback por tipo de serviço
            else {
                const serviceType = appointment.serviceType;
                const DEFAULT_VALUES = {
                    'evaluation': 200,
                    'neuropsych_evaluation': 300,
                    'return': 100,
                    'individual_session': 150,
                    'package_session': 150,
                    'convenio_session': 80,
                    'alignment': 150,
                    'meet': 150
                };
                finalSessionValue = DEFAULT_VALUES[serviceType] || 150;
            }
        }

        // 🔧 correlationId já foi gerado na linha 133, reutiliza
        
        const updateData = {
            operationalStatus: 'confirmed',
            clinicalStatus: 'completed',
            sessionValue: finalSessionValue,  // ✅ Garantir que o valor seja salvo
            completedAt: new Date(),
            updatedAt: new Date(),
            correlationId,  // 🔥 ESSENCIAL: garante correlationId no documento
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
        
        // 🔧 Se criou nova session, vincula ao appointment
        if (appointment.session && !appointment.sessionId) {
            updateData.session = appointment.session;
            updateData.sessionId = appointment.sessionId || appointment.session;
        }

        // 🔒 BLINDAGEM: Resolve status financeiro (Payment é a fonte da verdade)
        const financialStatus = this.resolveFinancialStatus(appointment, paymentResult, addToBalance);
        
        updateData.paymentStatus = financialStatus.status;
        updateData.visualFlag = financialStatus.visualFlag;
        
        // Atualiza paymentOrigin se relevante
        if (financialStatus.paymentOrigin) {
            updateData.paymentOrigin = financialStatus.paymentOrigin;
        }

        await this.Appointment.findByIdAndUpdate(appointmentId, updateData, { session: mongoSession });
        
        // 🔒 SINCRONIZAÇÃO: Atualiza Session para refletir o status financeiro
        if (session?._id || appointment.session) {
            const sessionIdToUpdate = session?._id || appointment.session;
            await this.Session.findByIdAndUpdate(
                sessionIdToUpdate,
                {
                    paymentStatus: financialStatus.status,
                    isPaid: financialStatus.isPaid,
                    visualFlag: financialStatus.visualFlag,
                    paymentOrigin: financialStatus.paymentOrigin,
                    updatedAt: new Date()
                },
                { session: mongoSession }
            );
            console.log(`[CompleteService] Session ${sessionIdToUpdate} sincronizada: ${financialStatus.status}`);
        }

        // 🏦 LEDGER: Registra movimentação contábil (auditoria)
        await this.recordLedgerEntry(appointment, financialStatus, paymentResult, correlationId, userId, mongoSession);

        // 🔧 Atualiza objeto appointment com correlationId para o evento
        appointment.correlationId = correlationId;

        // 7. Publica eventos (⚡ ASSÍNCRONO: não bloqueia resposta HTTP)
        // 🔥 CRITICAL: Eventos são fire-and-forget para resposta instantânea
        const eventData = { appointment, paymentResult, correlationId, mongoSession };
        this.scheduleEventPublishing(eventData);

        // 🔧 Retorna sessionId correto (existente ou nova)
        const finalSessionId = session?._id?.toString() || appointment.session?.toString();
        
        return {
            status: 'completed',
            appointmentId,
            sessionId: finalSessionId,
            packageConsumed,
            paymentResult,
            addToBalance
        };
    } // 🔒 FIM _completeInternal

    /**
     * 🔒 BLINDAGEM FINANCEIRA: Resolve status financeiro final
     * 
     * Regra: Payment é a ÚNICA fonte da verdade financeira
     * Session e Appointment apenas REFLETEM
     * 
     * @param {Object} appointment - Appointment
     * @param {Object} paymentResult - Resultado do processPayment
     * @param {Boolean} addToBalance - Se é fiado
     * @returns {Object} { status, visualFlag, isPaid, paymentOrigin }
     */
    /**
     * 🏦 Registra lançamento no Ledger Contábil
     */
    async recordLedgerEntry(appointment, financialStatus, paymentResult, correlationId, userId, mongoSession) {
        try {
            // PACOTE: Registra reconhecimento de receita
            if (appointment.package && financialStatus.isPaid) {
                await LedgerService.recordPackageSessionConsumed(
                    { 
                        _id: appointment.session, 
                        patient: appointment.patient,
                        appointment: appointment._id,
                        completedAt: new Date(),
                        correlationId
                    },
                    appointment.package,
                    { 
                        userId, 
                        userName: 'Sistema', 
                        correlationId 
                    },
                    mongoSession
                );
                console.log(`[Ledger] Lançamento de pacote registrado`);
                return;
            }
            
            // FIADO: Registra como pendente
            if (financialStatus.paymentOrigin === 'manual_balance') {
                // Não registra no ledger ainda - só quando for pago
                console.log(`[Ledger] Fiado - não registrado no ledger (aguardando pagamento)`);
                return;
            }
            
            // PAGAMENTO DIRETO: Registra receita
            if (paymentResult?.paymentId && financialStatus.isPaid) {
                // Busca o payment para ter todos os dados
                const payment = await this.Payment.findById(paymentResult.paymentId);
                if (payment) {
                    await LedgerService.recordPaymentReceived(
                        payment,
                        { 
                            userId, 
                            userName: 'Sistema', 
                            correlationId 
                        },
                        mongoSession
                    );
                    console.log(`[Ledger] Receita registrada: ${payment.amount}`);
                }
            }
        } catch (ledgerError) {
            // Não quebra o fluxo principal, mas loga o erro
            console.error(`[Ledger] ERRO ao registrar:`, ledgerError.message);
            // Aqui poderia enviar para um sistema de alertas
        }
    }

    resolveFinancialStatus(appointment, paymentResult, addToBalance) {
        // 1. PACOTE PRÉ-PAGO - sempre pago
        if (appointment.package) {
            return {
                status: 'package_paid',
                visualFlag: 'ok',
                isPaid: true,
                paymentOrigin: 'package_prepaid'
            };
        }
        
        // 2. FIADO (addToBalance) - pendente
        if (addToBalance) {
            return {
                status: 'pending',
                visualFlag: 'pending',
                isPaid: false,
                paymentOrigin: 'manual_balance'
            };
        }
        
        // 3. PAGAMENTO EXISTENTE/PROCESSADO
        if (paymentResult) {
            // 3a. Já está pago
            if (paymentResult.isPaid) {
                return {
                    status: 'paid',
                    visualFlag: 'ok',
                    isPaid: true,
                    paymentOrigin: paymentResult.type || 'direct'
                };
            }
            
            // 3b. Pagamento criado mas pendente
            if (paymentResult.paymentId) {
                return {
                    status: 'pending',
                    visualFlag: 'pending',
                    isPaid: false,
                    paymentOrigin: paymentResult.type || 'pending'
                };
            }
        }
        
        // 4. FALLBACK - pendente (não deve chegar aqui, mas protege)
        return {
            status: 'pending',
            visualFlag: 'pending',
            isPaid: false,
            paymentOrigin: 'unknown'
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
