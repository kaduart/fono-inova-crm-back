// services/completeSessionService.v2.js
// 🚀 COMPLETE SESSION SERVICE V2 - Mutação de estado primária
// 
// Responsabilidade: Mutar estado da sessão e package APÓS execução clínica
// NÃO é reversão (cancel) - é commit da execução
//
// Regras por tipo:
// - particular per-session: gera dívida (balance += value)
// - convenio: no_charge (faturamento batch posterior)
// - liminar: consome crédito judicial
// - prepaid: apenas contadores (já foi pago)

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import LiminarGuard from './financialGuard/guards/liminar.guard.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Patient from '../models/Patient.js';
import Lead from '../models/Leads.js';
import PatientBalance from '../models/PatientBalance.js';
import FinanceWriteGuard from './financialGuard/FinanceWriteGuard.js';
import { ConvenioHandler, LiminarHandler, ParticularHandler, buildCompleteContext } from './completeSession/index.js';
import FinancialGuard from './financialGuard/index.js';
import FinancialLedger from '../models/FinancialLedger.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import {
    recordPaymentReceived,
    recordPackageSessionConsumed,
    recordSessionRevenue
} from './financialLedgerService.js';
import { invalidateDashboardCache } from '../routes/financialDashboard.v2.js';
import { createCommissionSnapshot } from './commissionRule.service.js';
import Doctor from '../models/Doctor.js';

/**
 * Completa uma sessão - Mutação primária de estado
 * 
 * @param {string} appointmentId - ID do agendamento
 * @param {Object} options - Opções de completação
 * @param {mongoose.ClientSession} externalSession - Sessão MongoDB externa (opcional)
 * @returns {Object} Resultado da operação
 */
export async function completeSessionV2(appointmentId, options = {}, externalSession = null) {
    const {
        notes = '',
        evolution = '',
        userId,
        addToBalance = false,
        balanceAmount,
        balanceDescription,
        correlationId = `complete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    } = options;

    const startTime = Date.now();

    console.log(`[CompleteSessionV2] Iniciando`, {
        appointmentId,
        correlationId,
        addToBalance,
        optionsReceived: options
    });

    // ============================================================
    // 🔒 LOCK ATÔMICO — PRIMEIRA OPERAÇÃO, antes de qualquer leitura
    // Condição única: não está completado E não está processando.
    // Dois requests simultâneos (double-click): só um passa aqui.
    // Elimina TOCTOU — sem leitura prévia, sem stale check.
    // ============================================================
    const _lockCandidate = await Appointment.findOneAndUpdate(
        {
            _id: appointmentId,
            isProcessing: { $ne: true },
            operationalStatus: { $ne: 'completed' }
        },
        { $set: { isProcessing: true, processingStartedAt: new Date() } },
        { new: false }
    );

    if (!_lockCandidate) {
        const _current = await Appointment.findById(appointmentId)
            .select('operationalStatus isProcessing processingStartedAt clinicalStatus paymentStatus balanceAmount isPaid completedAt')
            .lean();

        if (!_current) throw new Error('Agendamento não encontrado');

        if (_current.operationalStatus === 'completed') {
            console.log(`[CompleteSessionV2] ✅ Idempotente — já completado (${appointmentId})`);
            return {
                success: true,
                idempotent: true,
                message: 'Sessão já estava completada',
                data: {
                    appointmentId,
                    clinicalStatus: _current.clinicalStatus,
                    operationalStatus: _current.operationalStatus,
                    paymentStatus: _current.paymentStatus,
                    balanceAmount: _current.balanceAmount,
                    isPaid: _current.isPaid,
                    completedAt: _current.completedAt
                },
                meta: { version: 'v2', correlationId, timestamp: new Date().toISOString() }
            };
        }

        const _lockAge = _current.processingStartedAt
            ? Date.now() - new Date(_current.processingStartedAt).getTime()
            : Infinity;

        if (_lockAge < 2 * 60 * 1000) {
            console.warn(`[CompleteSessionV2] ⏸️ Appointment ${appointmentId} já está processando (lock de ${Math.round(_lockAge / 1000)}s)`);
            throw new Error('APPOINTMENT_ALREADY_PROCESSING: Agendamento já está sendo processado. Aguarde.');
        }

        console.warn(`[CompleteSessionV2] 🔓 Lock expirado de ${Math.round(_lockAge / 1000)}s — recuperando ${appointmentId}`);
        await Appointment.updateOne(
            { _id: appointmentId },
            { $set: { isProcessing: true, processingStartedAt: new Date() } }
        );
    }

    // ============================================================
    // FASE 1: BUSCAR DADOS (lock garantido acima)
    // ============================================================
    let appointment = await Appointment.findById(appointmentId)
        .populate('session patient doctor package liminarContract')
        .lean();

    if (!appointment) {
        throw new Error('Agendamento não encontrado');
    }

    // Retorno: completa sem nenhum processamento financeiro
    if (appointment.serviceType === 'return') {
        await Appointment.findByIdAndUpdate(appointmentId, {
            $set: {
                operationalStatus: 'completed',
                clinicalStatus: 'completed',
                paymentStatus: 'not_applicable',
                sessionValue: 0,
                isProcessing: false,
                completedAt: new Date(),
                updatedAt: new Date()
            }
        });
        console.log(`[CompleteSessionV2] ✅ Retorno completado sem caixa: ${appointmentId}`);
        return {
            success: true,
            appointmentId,
            correlationId,
            note: 'return - no financial processing'
        };
    }

    const isCancelledStatus = (status) =>
        status && ['canceled', 'cancelled', 'cancelado', 'processing_cancel'].includes(status.toLowerCase());

    // 🔄 REVERTE CANCELAMENTO (com lock ativo — sem race condition)
    if (isCancelledStatus(appointment.operationalStatus)) {
        console.log(`[completeSessionV2] 🔄 Revertendo cancelamento do appointment ${appointmentId} antes de completar`);
        await Appointment.findByIdAndUpdate(appointmentId, {
            $set: {
                operationalStatus: 'scheduled',
                clinicalStatus: 'pending',
                updatedAt: new Date()
            }
        });
        appointment = await Appointment.findById(appointmentId).populate('session payment package');
    }

    // 🩹 FALLBACK CRÍTICO: session pode não estar populada (replica lag / lean inconsistency)
    let sessionId = appointment.session?._id || appointment.session;
    if (appointment.session && !sessionId) {
        const rawSessionId = appointment.session._id || appointment.session;
        if (rawSessionId) {
            const loadedSession = await Session.findById(rawSessionId).lean();
            if (loadedSession) {
                sessionId = loadedSession._id;
                appointment.session = loadedSession;
                console.log(`[CompleteSessionV2] 🛡️ Session carregada via fallback`, {
                    sessionId: sessionId?.toString?.()
                });
            }
        }
    }

    let packageId = appointment.package?._id;
    let packageData = appointment.package;
    
    // 🛡️ FALLBACK CRÍTICO: se package não foi populado, buscar explicitamente
    // Populate falha intermitentemente em produção (replica lag / race condition)
    if (appointment.package && !packageData?.model && !packageData?.type && !packageData?.paymentType) {
        const rawPkgId = appointment.package._id || appointment.package;
        if (rawPkgId) {
            packageData = await Package.findById(rawPkgId).lean();
            packageId = packageData?._id;
            console.log(`[CompleteSessionV2] 🛡️ Package carregado via fallback`, {
                rawPkgId: rawPkgId.toString?.(),
                packageId: packageId?.toString(),
                model: packageData?.model,
                type: packageData?.type,
                paymentType: packageData?.paymentType
            });
        }
    }

    // 🛡️ FALLBACK SESSÃO: appointment.package pode ser null por desvinculação/bug
    // Se session ainda tem o package, usa ele como fonte de verdade
    if (!packageId && appointment.session?.package) {
        const rawPkgId = appointment.session.package._id || appointment.session.package;
        if (rawPkgId) {
            packageData = await Package.findById(rawPkgId).lean();
            packageId = packageData?._id;
            console.log(`[CompleteSessionV2] 🛡️ Package resgatado via session.package (appointment.package era null)`, {
                rawPkgId: rawPkgId.toString?.(),
                packageId: packageId?.toString()
            });
            // Reconecta appointment ao package para consistência futura
            await Appointment.findByIdAndUpdate(appointmentId, { $set: { package: packageId } });
        }
    }
    
    // DEBUG: Log completo do appointment
    console.log(`[CompleteSessionV2] DEBUG Appointment:`, {
        appointmentId: appointment._id?.toString(),
        sessionId: sessionId?.toString(),
        packageId: packageId?.toString(),
        packageType: packageData?.type,
        hasPackageData: !!packageData,
        rawPackage: appointment.package ? 'exists' : 'null/undefined',
        sessionValue: appointment.sessionValue,
        packageSessionValue: packageData?.sessionValue
    });
    
    // 🎯 FONTE ÚNICA DA VERDADE: determineBillingType resolve tudo
    const billingType = determineBillingType(appointment, packageData);
    
    console.log(`[CompleteSessionV2] Billing determinado`, {
        billingType,
        packageModel: packageData?.model,
        packageType: packageData?.type,
        packagePaymentType: packageData?.paymentType
    });
    
    const isBalanceOrigin = addToBalance ||
        appointment.paymentOrigin === 'manual_balance' ||
        appointment.paymentOrigin === 'add_to_balance' ||
        (appointment.balanceAmount > 0 && !appointment.sessionValue);

    let sessionValue = (isBalanceOrigin && balanceAmount > 0)
        ? balanceAmount
        : (options.sessionValue || appointment.sessionValue || packageData?.sessionValue || 0);
    
    // 🩹 RECUPERAÇÃO: se sessionValue ainda é 0, tenta outras fontes
    if (!sessionValue || sessionValue <= 0) {
        const fallbackValue = appointment.paymentAmount || appointment.sessionValue || packageData?.sessionValue || 0;
        if (fallbackValue > 0) {
            console.log(`[CompleteSessionV2] 🩹 sessionValue recuperado: ${fallbackValue} (original: ${sessionValue})`);
            sessionValue = fallbackValue;
        }
    }
    
    // 🚨 VALIDAÇÃO: liminar exige sessionValue > 0 (consome crédito)
    if (billingType === 'liminar' && (!sessionValue || sessionValue <= 0)) {
        throw new Error(`INVALID_SESSION_VALUE: Liminar exige valor de sessão > 0. Recebido: ${sessionValue}`);
    }

    console.log(`[CompleteSessionV2] Dados processados`, {
        billingType,
        sessionValue,
        hasPackage: !!packageId,
        willUpdatePackage: !!packageId
    });

    // 🚨 VALIDAÇÃO: Não permitir addToBalance em pacotes pré-pagos (prepaid/full/liminar)
    // per-session: paga individualmente por sessão → PERMITE addToBalance
    const pkgPaymentType = packageData?.paymentType;
    const isPerSessionPkg = pkgPaymentType === 'per-session' || pkgPaymentType === 'per_session';
    const isPaidPackage = ['liminar'].includes(billingType)
        || (!!packageId && !isPerSessionPkg);

    console.log(`[CompleteSessionV2] Validação addToBalance:`, { billingType, addToBalance, isPaidPackage, pkgPaymentType });

    if (isPaidPackage && addToBalance) {
        const typeLabel = billingType === 'convenio' ? 'convênio' :
                         billingType === 'liminar' ? 'liminar' : 'já pago';
        throw new Error(`SESSION_ALREADY_PAID: Esta sessão faz parte de um pacote ${typeLabel} e não pode gerar saldo devedor`);
    }

    // ============================================================
    // FASE 2: TRANSAÇÃO DE MUTAÇÃO
    // ============================================================
    const mongoSession = externalSession || await mongoose.startSession();
    
    // 🎯 Variável para compartilhar estado entre Session e Appointment
    let sessionUpdate = null;
    let sessionDoc = null;
    let packageJustFinished = false; // flag para cancelar appointments FORA da transação

    // Contexto imutável passado aos handlers de billingType
    // sessionDoc começa null e é preenchido após Session.findById abaixo
    const ctx = buildCompleteContext({
        appointment, appointmentId, sessionId, sessionDoc: null,
        packageId, packageData, billingType, sessionValue,
        mongoSession, userId, correlationId,
        isBalanceOrigin, isPerSessionPkg, addToBalance, balanceAmount
    });
    
    try {
        if (!externalSession) {
            await mongoSession.startTransaction();
        }

        // 1. Verificar e atualizar Session (se existir)
        if (sessionId) {
            sessionDoc = await Session.findById(sessionId).session(mongoSession);
            ctx.sessionDoc = sessionDoc; // disponibiliza para handlers verificarem estado anterior
            if (!sessionDoc) {
                throw new Error('SESSION_NOT_FOUND: Sessão não encontrada');
            }
            const isCancelledStatus = (status) => 
                status && ['canceled', 'cancelled', 'cancelado', 'processing_cancel'].includes(status.toLowerCase());
            
            // 🔄 REVERTE CANCELAMENTO: se sessão foi cancelada mas agora vai ser completada,
            // primeiro reverte para scheduled (equivale a "reativar" a sessão)
            if (isCancelledStatus(sessionDoc.status)) {
                console.log(`[completeSessionV2] 🔄 Revertendo cancelamento da sessão ${sessionId} antes de completar`);
                await Session.findByIdAndUpdate(sessionId, {
                    $set: {
                        status: 'scheduled',
                        canceledAt: null,
                        cancelReason: null,
                        confirmedAbsence: null,
                        updatedAt: new Date()
                    }
                }, { session: mongoSession });
                // Recarrega sessionDoc após reversão
                sessionDoc = await Session.findById(sessionId).session(mongoSession);
                ctx.sessionDoc = sessionDoc;
            }
            
            // 📐 Snapshot da comissão aplicada no momento do complete
            const doctorForCommission = await Doctor.findById(appointment.doctor?._id)
                .select('specialty commissionRules commissionRuleVersion')
                .lean();
            if (doctorForCommission) {
                const commissionSnapshot = createCommissionSnapshot(
                    doctorForCommission,
                    sessionDoc,
                    new Date()
                );
                sessionUpdate = {
                    status: 'completed',
                    completedAt: new Date(),
                    notes: notes || undefined,
                    evolution: evolution || undefined,
                    correlationId,
                    commissionSnapshot
                };
            } else {
                sessionUpdate = {
                    status: 'completed',
                    completedAt: new Date(),
                    notes: notes || undefined,
                    evolution: evolution || undefined,
                    correlationId
                };
            }
            
            // 💰 REGRA UNIFICADA: isPaid = !isBalanceOrigin (para todos os tipos)
            const paidNow = !isBalanceOrigin;
            
            if (billingType === 'liminar') {
                LiminarHandler.buildSessionUpdate(sessionUpdate, ctx);
            } else if (billingType === 'convenio') {
                ConvenioHandler.buildSessionUpdate(sessionUpdate, ctx);
            } else {
                // TODOS os casos de particular: prepaid, per-session, avulso, fiado
                ParticularHandler.buildSessionUpdate(sessionUpdate, ctx);
            }
            
            await Session.findByIdAndUpdate(
                sessionId,
                { $set: sessionUpdate },
                {
                    session: mongoSession,
                    __fromFinancialGuard: true,
                    __guardContext: 'FINANCIAL'
                }
            );
            console.log(`[CompleteSessionV2] Session ${sessionId} → completed (${billingType})`, {
                isPaid: sessionUpdate.isPaid,
                paymentStatus: sessionUpdate.paymentStatus,
                addToBalance
            });
        }

        // 2. Atualizar Package (SEMPRE que tiver package)
        let packageUpdateResult = null;
        if (packageId) {
            // ══════════════════════════════════════════════════════════
            // LEGACY PACKAGE UPDATE — DESATIVADO PARA 'particular' E 'liminar'
            // ParticularHandler.buildPayment é a única fonte de verdade para particular.
            // LiminarHandler debita LiminarContract diretamente — NÃO toca Package.
            // ConvenioHandler tem branch 'no_charge' — não altera Package balance.
            // Mantido APENAS para convenio até remoção total.
            // ══════════════════════════════════════════════════════════
            if (billingType === 'convenio') {
                // ══════════════════════════════════════════════════════════
                // SHADOW MODE: valida package.guard vs updatePackageOnComplete
                // Roda em sessão separada e ABORTA — não afeta dados reais.
                // Comparar os resultados antes de remover updatePackageOnComplete (Passo 4).
                // ══════════════════════════════════════════════════════════
                let guardShadowResult = null;
                const shadowSession = await mongoose.startSession();
                try {
                    await shadowSession.startTransaction();
                    // prepaid fica como 'prepaid' para o guard (determineBillingType mapeia para 'particular')
                    const guardBillingType = packageData?.model === 'prepaid' ? 'prepaid' : billingType;
                    guardShadowResult = await FinancialGuard.execute({
                        context: 'COMPLETE_SESSION',
                        billingType: guardBillingType,
                        payload: {
                            packageId: packageId.toString(),
                            sessionValue,
                            paymentOrigin: sessionUpdate?.paymentOrigin || 'auto_per_session',
                            appointmentId: appointmentId?.toString(),
                            billingType: guardBillingType
                        },
                        session: shadowSession
                    });
                    console.log('[CompleteSessionV2][SHADOW] Guard executado', {
                        packageId: packageId.toString(),
                        sessionsRemaining: guardShadowResult.sessionsRemaining,
                        newBalance: guardShadowResult.newBalance,
                        financialStatus: guardShadowResult.financialStatus,
                        isFinished: guardShadowResult.isFinished
                    });
                } catch (shadowErr) {
                    guardShadowResult = { error: shadowErr.message };
                    console.error('[CompleteSessionV2][SHADOW] Guard erro (shadow ignorado):', shadowErr.message);
                } finally {
                    await shadowSession.abortTransaction();
                    shadowSession.endSession();
                }

                packageUpdateResult = await updatePackageOnComplete(
                    packageId,
                    sessionValue,
                    billingType,
                    mongoSession
                );
                console.log(`[CompleteSessionV2] Package ${packageId} atualizado`, packageUpdateResult);

                // Compara guard shadow vs legacy
                if (guardShadowResult && !guardShadowResult.error) {
                    const divergences = [];

                    if (guardShadowResult.sessionsRemaining !== packageUpdateResult.sessionsRemaining) {
                        divergences.push({
                            field: 'sessionsRemaining',
                            guard: guardShadowResult.sessionsRemaining,
                            legacy: packageUpdateResult.sessionsRemaining
                        });
                    }

                    const legacyIsFinished = packageUpdateResult.sessionsDone >= (packageData?.totalSessions || Infinity);
                    if (guardShadowResult.isFinished !== legacyIsFinished) {
                        divergences.push({
                            field: 'isFinished',
                            guard: guardShadowResult.isFinished,
                            legacy: legacyIsFinished
                        });
                    }

                    const ctx = {
                        packageId: packageId.toString(),
                        patientId: appointment.patient?._id?.toString(),
                        appointmentId: appointmentId?.toString(),
                        billingType,
                        sessionValue,
                        guard: {
                            sessionsRemaining: guardShadowResult.sessionsRemaining,
                            newBalance: guardShadowResult.newBalance,
                            financialStatus: guardShadowResult.financialStatus,
                            isFinished: guardShadowResult.isFinished
                        },
                        legacy: {
                            sessionsRemaining: packageUpdateResult.sessionsRemaining,
                            sessionsDone: packageUpdateResult.sessionsDone,
                            isFinished: legacyIsFinished
                        }
                    };

                    if (divergences.length > 0) {
                        console.warn('[CompleteSessionV2][SHADOW] ⚠️ DIVERGÊNCIA DETECTADA', { ...ctx, divergences });
                    } else {
                        console.log('[CompleteSessionV2][SHADOW] ✅ paridade confirmada', ctx);
                    }
                }
            } else {
                console.log('[CompleteSessionV2] Package update pulado — ParticularHandler é fonte de verdade');
            }

            // 2b. Marcar pacote como finished se todas as sessões ativas foram concluídas
            // Roda para TODOS os billingTypes (inclusive particular), pois ParticularHandler
            // não gerencia lifecycle de status do Package.
            const pkgAtualParaFinished = await Package.findById(packageId).session(mongoSession).lean();
            const allSessions = await Session.find({ package: packageId }).session(mongoSession).lean();
            const activeSessions = allSessions.filter(s => s.status !== 'canceled');
            const completedSessions = allSessions.filter(s => s.status === 'completed');

            if (activeSessions.length > 0 && completedSessions.length >= activeSessions.length) {
                await Package.findByIdAndUpdate(
                    packageId,
                    { status: 'finished' },
                    { session: mongoSession }
                );
                packageJustFinished = true;
                console.log(`[CompleteSessionV2] ✅ Pacote ${packageId} → finished (${completedSessions.length}/${activeSessions.length} ativas concluídas)`);
                // 🔄 Cancelamento de appointments movido para FORA da transação
                // Motivo: Appointment.updateMany via Mongoose dispara middleware que
                // não é transaction-aware, causando abort da transação na última sessão.
            }
        }

        // 3. Atualizar Appointment (usando Session como fonte da verdade)
        const appointmentUpdate = {
            $set: {
                operationalStatus: 'completed',  // 🎯 CRM: fonte da verdade
                clinicalStatus: 'completed',
                completedAt: new Date(),
                updatedAt: new Date(),
                completionNotes: notes,
                evolution: evolution,
                correlationId
            }
        };

        // 🎯 Fonte da verdade: Session define o pagamento, Appointment espelha
        if (sessionId && sessionUpdate) {
            FinanceWriteGuard.setAppointmentPaid(appointmentUpdate.$set, sessionUpdate.isPaid ?? false, { reason: 'mirror_from_session' });
            FinanceWriteGuard.setAppointmentPaymentStatus(appointmentUpdate.$set, sessionUpdate.paymentStatus ?? 'unknown', { reason: 'mirror_from_session' });
            const validPaymentMethods = ['pix', 'cartão', 'dinheiro', 'convenio', 'liminar_credit', 'credit_card', 'debit_card', 'cash', 'bank_transfer', 'other', 'credito', 'debito', 'cartao_credito', 'cartao_debito', 'transferencia', 'transferencia_bancaria'];
            const rawMethod = appointment.paymentMethod || packageData?.paymentMethod;
            appointmentUpdate.$set.paymentMethod = validPaymentMethods.includes(rawMethod) ? rawMethod : 'pix';
            // convenio e liminar: paciente nunca deve balance (paga pelo plano/crédito)
            const patientOwesBalance = !['convenio', 'liminar'].includes(billingType);
            appointmentUpdate.$set.balanceAmount = (!patientOwesBalance || sessionUpdate.isPaid) ? 0 : (sessionValue || 0);
            
            console.log(`[CompleteSessionV2] Appointment espelhando Session:`, {
                isPaid: appointmentUpdate.$set.isPaid,
                paymentStatus: appointmentUpdate.$set.paymentStatus,
                paymentMethod: appointmentUpdate.$set.paymentMethod
            });
        } else if (!sessionId) {
            /**
             * ⚠️ LEGADO — NÃO UTILIZAR
             *
             * Fallback para appointments criados antes da trinidade Session-first.
             * Hoje TODOS os appointments novos têm Session vinculada.
             *
             * 🚫 NÃO USAR para novos fluxos
             * 🚫 NÃO ALTERAR sem entender o histórico
             *
             * ✅ Substituído por: arquitetura Session-first (Appointment + Session + Payment)
             *
             * Mantido temporariamente para compatibilidade com dados antigos.
             * TODO: remover após backfill completo de Session em todos os appointments.
             */
            const isPaid = billingType === 'liminar';
            FinanceWriteGuard.setAppointmentPaid(appointmentUpdate.$set, isPaid, { reason: 'fallback_no_session' });
            FinanceWriteGuard.setAppointmentPaymentStatus(appointmentUpdate.$set, isPaid ? 'paid' : 'pending', { reason: 'fallback_no_session' });
            appointmentUpdate.$set.paymentMethod = billingType === 'liminar' ? 'liminar_credit' :
                                                   billingType === 'convenio' ? 'convenio' :
                                                   packageId ? 'package_prepaid' : 'cash';
            appointmentUpdate.$set.balanceAmount = isPaid ? 0 : (sessionValue || 0);
            
            console.log(`[CompleteSessionV2] Fallback (sem session):`, {
                isPaid,
                paymentStatus: appointmentUpdate.$set.paymentStatus,
                billingType
            });
        }

        // 💰 CRIAR OU ATUALIZAR PAYMENT — Handler dispatch (novo modelo)
        let paymentCreated = null;
        if (billingType === 'particular' && sessionValue > 0) {
            paymentCreated = await ParticularHandler.buildPayment(appointmentUpdate, ctx);
        } else if (billingType === 'liminar' && sessionValue > 0) {
            paymentCreated = await LiminarHandler.buildPayment(appointmentUpdate, ctx);
        } else if (packageId && !['convenio', 'liminar'].includes(billingType) && sessionValue > 0) {
            // ═══════════════════════════════════════════════════════════════
            // LEGACY PACKAGE FALLBACK — NÃO EVOLUIR
            //
            // Este bloco existe apenas para suportar appointments antigos onde:
            //   - billingType não é 'particular' (ex: 'prepaid', 'therapy', undefined)
            //   - mas existe packageId
            //
            // Em dados novos, billingType é sempre 'particular' e cai no ParticularHandler.
            // Pacote NÃO é um tipo financeiro — é forma de consumo dentro do particular.
            //
            // TODO: remover após backfill completo de billingType nos dados legados.
            // ═══════════════════════════════════════════════════════════════
            console.warn('[LEGACY_PACKAGE_FLOW_TRIGGERED] Appointment com packageId mas billingType legado', {
                appointmentId,
                billingType,
                packageId
            });

            const sessionDate = sessionDoc?.date || appointment.date || new Date();

            if (appointment.payment) {
                const existingPaymentId = appointment.payment._id || appointment.payment;
                const existingPayment = await Payment.findById(existingPaymentId).session(mongoSession).lean();

                // 🛡️ Preserva datas apenas se payment já estava 'paid' (idempotência em re-complete)
                const legacyAlreadyPaid = existingPayment?.status === 'paid';
                const preservePaymentDate = legacyAlreadyPaid ? (existingPayment?.paymentDate || sessionDate) : sessionDate;
                const preserveFinancialDate = legacyAlreadyPaid ? (existingPayment?.financialDate || sessionDate) : sessionDate;

                paymentCreated = await Payment.findByIdAndUpdate(
                    existingPaymentId,
                    {
                        $set: {
                            status: 'paid',
                            billingType: 'particular',
                            paymentMethod: 'package',
                            amount: sessionValue,
                            paidAt: new Date(),
                            paymentDate: preservePaymentDate,
                            financialDate: preserveFinancialDate,
                            serviceDate: sessionDate,
                            isFromPackage: true,
                            updatedAt: new Date()
                        },
                        $unset: { 'insurance.status': '' }
                    },
                    { session: mongoSession, new: true }
                );
            } else {
                const [paymentDoc] = await Payment.create([{
                    patient:       appointment.patient?._id,
                    amount:        sessionValue,
                    status:        'paid',
                    type:          'service',
                    serviceType:   'session',
                    paymentMethod: 'package',
                    paymentDate:   sessionDate,
                    paidAt:        new Date(),
                    billingType:   'particular',
                    serviceDate:   sessionDate,
                    description:   `Sessão de pacote realizada - ${appointment.patient?.fullName || 'Paciente'}`,
                    appointment:   appointmentId,
                    session:       sessionId,
                    createdBy:     userId,
                    kind:          'session_payment',
                    isFromPackage: true
                }], { session: mongoSession });
                paymentCreated = paymentDoc;
                appointmentUpdate.$set.payment = paymentCreated._id;
            }
        } else if (billingType === 'convenio') {
            // REPLACED BY: ConvenioHandler.buildPayment — PHASE: payment resolution
            // LEGACY (kept for reference — ver handlers/convenioHandler.js para lógica completa):
            // guia search, consumeSession, paymentData build, Payment.create/findByIdAndUpdate
            paymentCreated = await ConvenioHandler.buildPayment(appointmentUpdate, ctx);

            // CRÍTICO: vincular session.insuranceGuide obrigatoriamente após ConvenioHandler.
            //
            // Historicamente o fluxo preenchia appointment.insuranceGuide e payment.insurance.guideId
            // mas NÃO preenchia session.insuranceGuide. Resultado: a listagem de "A Faturar"
            // (insuranceBatchGuideAdapter.listGuidesPendingBilling) agrupa sessões por
            // session.insuranceGuide. Sem esse campo, a sessão vira falsa "órfã" mesmo tendo
            // guia e payment corretos — visualmente some do faturamento por guia.
            //
            // Em junho/2026 foi necessário backfill de 40 sessões afetadas (todas tinham
            // appointment.insuranceGuide preenchido mas session.insuranceGuide = null).
            // NÃO remover este bloco.
            if (sessionId && paymentCreated?.insurance?.guideId) {
                await Session.findByIdAndUpdate(
                    sessionId,
                    { $set: { insuranceGuide: paymentCreated.insurance.guideId } },
                    { session: mongoSession }
                );
                console.log(`[CompleteSessionV2] Session ${sessionId} vinculada à guia ${paymentCreated.insurance.guideId}`);
            }
        }

        // Sync paymentStatus from payment for service types without Session (evaluation, tongue_tie_test, etc)
        if (paymentCreated && !sessionId) {
            const derivedStatus = paymentCreated.status === 'paid' ? 'paid'
                : paymentCreated.status === 'pending' ? 'pending'
                : 'unpaid';
            FinanceWriteGuard.setAppointmentPaymentStatus(appointmentUpdate.$set, derivedStatus, { reason: 'sync_from_payment' });
            FinanceWriteGuard.setAppointmentPaid(appointmentUpdate.$set, paymentCreated.status === 'paid', { reason: 'sync_from_payment' });
            console.log(`[CompleteSessionV2] Synced paymentStatus from payment (no session):`, derivedStatus);
        }

        // 🔄 Bypass do financialSanitizer para espelhar estado financeiro da Session
        // 🛡️ FLAG DE SEGURANÇA: prova que veio do completeSessionService autorizado
        appointmentUpdate.$set._fromCompleteService = true;
        await Appointment.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(appointmentId) },
            appointmentUpdate,
            { session: mongoSession }
        );

        // 🏦 REGISTRAR LANÇAMENTOS NO LEDGER FINANCEIRO (dentro da transação)
        // 1. Receita reconhecida para sessões AVULSAS (sem package)
        if (!packageId && sessionValue > 0) {
            const sessionForLedger = sessionDoc || {
                _id: sessionId,
                patient: appointment.patient?._id,
                appointmentId: appointmentId,
                sessionValue,
                paymentMethod: sessionUpdate?.paymentMethod || appointment.paymentMethod,
                sessionType: sessionDoc?.sessionType || appointment.sessionType,
                insuranceGuide: sessionDoc?.insuranceGuide || appointment.insuranceGuide,
                correlationId,
                completedAt: new Date()
            };
            await recordSessionRevenue(sessionForLedger, { userId, correlationId }, mongoSession);
            console.log(`[CompleteSessionV2] 🏦 Ledger: revenue_recognition registrado (${billingType})`);
        }

        // 2. Consumo de pacote
        if (packageId && packageUpdateResult) {
            const packageForLedger = {
                ...packageData,
                sessionsDone: packageUpdateResult.sessionsDone
            };
            const sessionForLedger = {
                _id: sessionDoc?._id || sessionId,
                patient: sessionDoc?.patient || appointment.patient?._id,
                appointment: sessionDoc?.appointmentId || appointmentId,
                correlationId
            };
            await recordPackageSessionConsumed(
                sessionForLedger,
                packageForLedger,
                { userId, correlationId },
                mongoSession
            );
            console.log(`[CompleteSessionV2] 🏦 Ledger: package_consumed registrado`);
        }

        if ((billingType === 'particular' || billingType === 'liminar') && sessionValue > 0) {
            if (paymentCreated) {
                await recordPaymentReceived(
                    paymentCreated,
                    { userId, correlationId },
                    mongoSession
                );
                console.log(`[CompleteSessionV2] 🏦 Ledger: payment_received registrado (${billingType})`);
            } else if (billingType === 'particular' && isBalanceOrigin) {
                await FinancialLedger.credit({
                    type: 'payment_pending',
                    amount: sessionValue,
                    patient: appointment.patient?._id,
                    appointment: appointmentId,
                    correlationId,
                    description: `Sessão particular fiada - ${appointment.patient?.fullName || 'Paciente'}`,
                    occurredAt: new Date(),
                    createdBy: userId,
                    metadata: {
                        source: 'session_complete',
                        billingType,
                        sessionValue
                    }
                }, mongoSession);
                console.log(`[CompleteSessionV2] 🏦 Ledger: payment_pending registrado`);

                // 🏦 PATIENT BALANCE: registra débito sincronamente dentro da transaction
                // Usamos findOneAndUpdate com upsert para criar/atualizar atomicamente dentro da session
                const balanceResult = await PatientBalance.findOneAndUpdate(
                    { patient: appointment.patient?._id },
                    {
                        $push: {
                            transactions: {
                                type: 'debit',
                                amount: sessionValue,
                                description: `Sessão fiada - ${appointment.patient?.fullName || 'Paciente'}`,
                                sessionId: sessionId || null,
                                appointmentId: appointmentId,
                                specialty: appointment.specialty || null,
                                correlationId,
                                registeredBy: userId,
                                transactionDate: new Date()
                            }
                        },
                        $inc: { currentBalance: sessionValue, totalDebited: sessionValue },
                        $setOnInsert: {
                            patient: appointment.patient?._id,
                            createdAt: new Date()
                        },
                        $set: { lastTransactionAt: new Date() }
                    },
                    { session: mongoSession, upsert: true, new: true }
                );
                console.log(`[CompleteSessionV2] 🏦 PatientBalance: débito registrado`, {
                    patientId: appointment.patient?._id?.toString(),
                    newBalance: balanceResult ? balanceResult.currentBalance : sessionValue
                });
            }
        }

        // 🔄 ATUALIZAR LEAD → PACIENTE (primeira sessão completa)
        if (appointment.patient?._id) {
            try {
                const patient = await Patient.findById(appointment.patient._id).session(mongoSession);
                if (patient) {
                    // Converte lead em paciente ativo
                    if (patient.status === 'lead' || patient.isLead === true) {
                        patient.status = 'active';
                        patient.isLead = false;
                        patient.convertedAt = new Date();
                        console.log(`[CompleteSessionV2] 🎯 Lead convertido para paciente: ${patient._id} (${patient.fullName})`);
                    }
                    
                    // Atualiza timestamps de sessão
                    if (!patient.firstSessionAt) {
                        patient.firstSessionAt = new Date();
                    }
                    patient.lastSessionAt = new Date();
                    
                    await patient.save({ session: mongoSession });

                    // 🔄 CONVERTER LEAD vinculado (funil real)
                    const lead = await Lead.findOne({
                        $or: [
                            { convertedToPatient: patient._id },
                            { _id: patient.createdFromLead }
                        ]
                    }).session(mongoSession);

                    if (lead) {
                        lead.convertedToPatient = patient._id;
                        lead.stage = 'paciente';
                        lead.status = 'virou_paciente';
                        await lead.save({ session: mongoSession });
                        console.log(`[CompleteSessionV2] 🎯 Lead convertido no funil: ${lead._id} → Patient ${patient._id}`);
                    }
                }
            } catch (leadErr) {
                console.warn(`[CompleteSessionV2] ⚠️ Erro ao atualizar patient/lead (não crítico):`, leadErr.message);
            }
        }

        if (!externalSession) {
            await mongoSession.commitTransaction();
        }

        console.log(`[CompleteSessionV2] ✅ Transação commitada (${Date.now() - startTime}ms)`);

        // 🔄 INVALIDA CACHE do dashboard para refletir novo caixa/produção em tempo real
        invalidateDashboardCache();

        // 🔄 Cancela appointments futuros do pacote (fora da transação — evita abort por Mongoose middleware)
        if (packageJustFinished && packageId) {
            try {
                const cancelResult = await Appointment.updateMany(
                    {
                        package: packageId,
                        operationalStatus: { $in: ['scheduled', 'pending', 'pre_agendado'] }
                    },
                    {
                        $set: {
                            operationalStatus: 'canceled',
                            clinicalStatus: 'canceled',
                            status: 'canceled',
                            cancellationReason: 'Pacote finalizado - sessões esgotadas',
                            updatedAt: new Date()
                        }
                    }
                );
                if (cancelResult.modifiedCount > 0) {
                    console.log(`[CompleteSessionV2] 🗑️ ${cancelResult.modifiedCount} appointment(s) futuro(s) cancelado(s) - pacote esgotado`);
                }
            } catch (cancelErr) {
                console.error(`[CompleteSessionV2] ⚠️ Erro ao cancelar appointments pós-finish (não crítico):`, cancelErr.message);
            }
        }

        // 🔄 REBUILD SÍNCRONO da view (frontend precisa ver dados atualizados)
        let viewRebuilt = false;
        if (packageId) {
            try {
                const { buildPackageView } = await import('../domains/billing/services/PackageProjectionService.js');
                await buildPackageView(packageId, { correlationId });
                console.log(`[CompleteSessionV2] 🔄 View do pacote ${packageId} reconstruída`);
                viewRebuilt = true;
            } catch (viewErr) {
                console.error(`[CompleteSessionV2] ⚠️ Erro ao reconstruir view:`, viewErr.message);
                // Não falha a operação, mas loga o erro
            }
        }

        // 🚀 PUBLICAR EVENTO para atualizar projections (async)
        if (packageId) {
            try {
                await publishEvent(
                    EventTypes.SESSION_COMPLETED,
                    {
                        appointmentId: appointmentId?.toString(),
                        sessionId: sessionId?.toString(),
                        packageId: packageId?.toString(),
                        patientId: appointment.patient?._id?.toString(),
                        doctorId: appointment.doctor?._id?.toString(),
                        billingType,
                        sessionValue,
                        viewRebuilt,
                        completedAt: new Date().toISOString()
                    },
                    { correlationId }
                );
                console.log(`[CompleteSessionV2] 📡 Evento SESSION_COMPLETED publicado`);
            } catch (eventErr) {
                console.error(`[CompleteSessionV2] ⚠️ Erro ao publicar evento:`, eventErr.message);
                // Não falha a operação se evento falhar
            }
        }

        return {
            success: true,
            appointmentId,
            sessionId: sessionId?.toString(),
            packageId: packageId?.toString(),
            billingType,
            sessionValue,
            packageUpdate: packageUpdateResult,
            paymentId: paymentCreated?._id?.toString(),
            correlationId
        };

    } catch (error) {
        console.error(`[CompleteSessionV2] ❌ Erro ORIGINAL:`, error.message, error.stack);
        if (!externalSession) {
            try {
                await mongoSession.abortTransaction();
            } catch (abortErr) {
                console.error(`[CompleteSessionV2] ⚠️ Erro ao abortar transação (já commitada?):`, abortErr.message);
            }
        }
        throw error;
    } finally {
        // 🔓 Libera lock (sempre, mesmo em caso de erro)
        if (appointmentId) {
            try {
                await Appointment.updateOne(
                    { _id: appointmentId },
                    { $set: { isProcessing: false }, $unset: { processingStartedAt: 1 } }
                );
            } catch (unlockErr) {
                console.error(`[CompleteSessionV2] ⚠️ Erro ao liberar lock (não crítico):`, unlockErr.message);
            }
        }
        if (!externalSession) {
            mongoSession.endSession();
        }
    }
}

/**
 * ⚠️ LEGADO — NÃO UTILIZAR
 *
 * Esta função fazia parte do fluxo antigo de atualização de Package no complete.
 * Hoje substituída pelos handlers:
 * - ParticularHandler (prepaid, per-session, avulso, fiado)
 * - LiminarHandler
 * - ConvenioHandler
 *
 * 🚫 NÃO USAR para novos fluxos
 * 🚫 NÃO ALTERAR sem entender o histórico
 *
 * Mantida temporariamente para billingType !== 'particular' (dados legados).
 * TODO: remover após backfill completo de billingType nos dados legados.
 */
async function updatePackageOnComplete(packageId, sessionValue, billingType, session) {
    console.log(`[updatePackageOnComplete] Iniciando`, {
        packageId: packageId?.toString(),
        sessionValue,
        billingType
    });
    
    const packageDoc = await Package.findById(packageId).session(session);
    
    if (!packageDoc) {
        console.error(`[updatePackageOnComplete] ❌ Package não encontrado: ${packageId}`);
        throw new Error('Package não encontrado');
    }
    
    console.log(`[updatePackageOnComplete] Package encontrado`, {
        currentDone: packageDoc.sessionsDone,
        currentRemaining: packageDoc.sessionsRemaining,
        currentBalance: packageDoc.balance,
        type: packageDoc.type
    });

    // Apenas incrementa sessionsDone (sessionsRemaining é calculado dinamicamente)
    const currentDone = packageDoc.sessionsDone || 0;
    const totalSessions = packageDoc.totalSessions || 0;
    
    // Invariante financeiro: não ultrapassar limite do pacote (ANTES de qualquer cálculo)
    if (currentDone >= totalSessions) {
        throw new Error(`PACKAGE_LIMIT_REACHED: Pacote esgotado (${currentDone}/${totalSessions}). Não é possível completar nova sessão.`);
    }
    
    const updateOps = {
        $inc: {
            sessionsDone: 1
        },
        $set: {
            updatedAt: new Date()
        }
    };

    // Lógica financeira por tipo
    switch (billingType) {
        case 'particular':
        case 'therapy':
            // Per-session: recalcula balance = (sessionsDone * sessionValue) - totalPaid
            // Balance positivo = deve sessões; Balance negativo = tem crédito
            if (sessionValue > 0) {
                const sessionsDone = (packageDoc.sessionsDone || 0) + 1;
                const totalSessionDebt = sessionsDone * sessionValue;
                const totalPaid = packageDoc.totalPaid || 0;
                const currentBalance = totalSessionDebt - totalPaid;
                updateOps.$set.balance = currentBalance;
                updateOps.$set.financialStatus = currentBalance > 0.001 ? 'unpaid' : 'paid';
            }
            break;
            
        case 'convenio':
            // Convênio: no_charge (faturamento batch posterior)
            // Não altera balance imediatamente
            break;
            
        case 'liminar':
            // Liminar: consome crédito (com proteção contra negativo)
            if (sessionValue > 0) {
                const currentBalance = packageDoc.liminarCreditBalance || 0;
                if (currentBalance < sessionValue) {
                    throw new Error(`LIMINAR_NO_CREDIT: Crédito insuficiente. Disponível: ${currentBalance}, Necessário: ${sessionValue}`);
                }
                updateOps.$inc.liminarCreditBalance = -sessionValue;
                // Revenue recognition (opcional, depende da RN)
            }
            break;
            
        case 'prepaid':
            // Prepaid: recalcula balance = totalValue - (sessionsDone * sessionValue)
            // Mostra crédito restante (negativo = crédito disponível)
            if (sessionValue > 0) {
                const sessionsDone = (packageDoc.sessionsDone || 0) + 1;
                const usedValue = sessionsDone * sessionValue;
                const remainingCredit = (packageDoc.totalValue || 0) - usedValue;
                updateOps.$set.balance = remainingCredit;
                updateOps.$set.financialStatus = remainingCredit > 0.001 ? 'paid_with_credit' : 'paid';
            }
            break;
            
        default:
            throw new Error(`BILLING_TYPE_INVALID: Tipo de billing não tratado no package update: ${billingType}`);
    }
    
    const result = await Package.updateOne(
        { _id: packageId },
        updateOps,
        { session }
    );
    
    console.log(`[updatePackageOnComplete] Update executado`, {
        modifiedCount: result.modifiedCount,
        updateOps: JSON.stringify(updateOps)
    });

    // Calcular remaining dinamicamente
    const finalDone = currentDone + 1;
    const finalRemaining = totalSessions - finalDone;
    
    return {
        modified: result.modifiedCount > 0,
        sessionsDone: finalDone,
        sessionsRemaining: finalRemaining,
        billingType
    };
}

/**
 * Determina o tipo de billing baseado no appointment/package.
 * ÚNICA fonte de verdade para billing no complete V2.
 * 
 * Mapeamentos:
 * - therapy (legado) -> particular
 * - per-session (legado) -> particular
 * - full (legado) -> prepaid
 */
function determineBillingType(appointment, packageData) {
    // 🎯 PRIORIDADE 0: LiminarContract vinculado diretamente (NOVO MODELO)
    // Sempre vence sobre packageData e billingType — é a fonte de verdade real.
    if (appointment?.liminarContract) {
        return 'liminar';
    }

    // 🎯 PRIORIDADE 1: Convênio explícito no appointment — nunca sobrescrito por packageData.
    // Pacote de convênio com paymentType='full' não é particular — é convênio faturado em batch.
    if (appointment?.billingType === 'convenio') {
        return 'convenio';
    }

    // 🛡️ GUARD: paymentMethod=convenio com billingType inconsistente = dado corrompido.
    // Particular nunca usa paymentMethod='convenio' — se aparecer aqui é dado errado.
    // Self-heal: roteamos para convenio para evitar que particularHandler marque como paid.
    if (appointment?.paymentMethod === 'convenio') {
        console.error('[determineBillingType] INCONSISTENT_BILLING: paymentMethod=convenio mas billingType!=convenio — corrigindo para convenio', {
            appointmentId: appointment._id,
            billingType: appointment.billingType,
            paymentMethod: appointment.paymentMethod
        });
        return 'convenio';
    }

    // 🎯 PRIORIDADE 2: Package model/type (fallback legado — apenas para particular)
    // ⚠️ LEGADO — LIMINAR NÃO USA MAIS PACKAGE
    // Esses fallbacks só existem para dados antigos (backfill pendente).
    // Fonte de verdade: appointment.liminarContract
    if (packageData?.model) {
        if (packageData.model === 'liminar') return 'liminar'; // ⚠️ LEGADO
        if (packageData.model === 'prepaid') return 'particular'; // 📦 pacote pré-pago → particular
        if (packageData.model === 'per_session') return 'particular';
    }
    if (packageData?.type) {
        if (packageData.type === 'liminar') return 'liminar'; // ⚠️ LEGADO
        if (packageData.type === 'therapy') return 'particular';
    }
    if (packageData?.paymentType) {
        if (packageData.paymentType === 'per-session') return 'particular';
        if (packageData.paymentType === 'full') return 'particular';
    }

    // 🎯 PRIORIDADE 3: billingType do appointment (sem package)
    if (appointment?.billingType) {
        return appointment.billingType;
    }

    // Default
    console.warn(`[CompleteSessionV2] 🚨 FALLBACK CRÍTICO: Package sem billingType, model, type ou paymentType definidos. Assumindo 'particular'. Verifique dados do package.`);
    return 'particular';
}

export default { completeSessionV2 };
