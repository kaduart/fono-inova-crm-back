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
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

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
    // FASE 1: BUSCAR DADOS (fora da transaction se possível)
    // ============================================================
    const appointment = await Appointment.findById(appointmentId)
        .populate('session patient doctor package')
        .lean();

    if (!appointment) {
        throw new Error('Agendamento não encontrado');
    }

    // 🛡️ IDEMPOTÊNCIA: Já completado? (CRM usa operationalStatus como fonte da verdade)
    if (appointment.operationalStatus === 'completed') {
        console.log(`[CompleteSessionV2] Sessão ${appointmentId} já completada (idempotência)`);
        return {
            success: true,
            idempotent: true,
            appointmentId,
            correlationId,
            message: 'Sessão já estava completada'
        };
    }

    // 🚫 Validações de segurança - CRM sempre usa operationalStatus
    const isCancelledStatus = (status) => 
        status && ['canceled', 'cancelled', 'cancelado', 'processing_cancel'].includes(status.toLowerCase());
    
    // 🎯 CRM: operationalStatus é a fonte da verdade para controle de agendamentos
    if (isCancelledStatus(appointment.operationalStatus)) {
        throw new Error('SESSION_CANCELLED: Esta sessão foi cancelada e não pode ser completada');
    }

    const sessionId = appointment.session?._id;
    const packageId = appointment.package?._id;
    const packageData = appointment.package;
    
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
    
    // Determinar tipo de billing
    let billingType = determineBillingType(appointment, packageData);
    
    // 🔥 V2 HARD CUT: Pacotes SEM campo 'model' E SEM tipo V2 conhecido NÃO são suportados
    // Regra: V2 aceita packages com 'model' (novos) OU type = 'liminar'/'convenio' (legado V2)
    const isV2Package = packageData?.model || 
                        ['liminar', 'convenio'].includes(packageData?.type);
    
    if (!isV2Package) {
        throw new Error('PACKAGE_V2_INCOMPATIBLE: Este pacote foi criado na versão antiga (V1) e não é compatível com o sistema atual. Crie um novo pacote ou use o endpoint V1 legado.');
    }
    
    // 🎯 FONTE DA VERDADE ÚNICA: package.model (novo) OU package.type (legado V2)
    const MODEL_TO_BILLING = {
        'prepaid': 'prepaid',
        'per_session': 'particular',
        'convenio': 'convenio',
        'liminar': 'liminar'
    };
    
    // Prioridade: model (novo) > type (legado)
    const packageModel = packageData?.model || packageData?.type;
    
    if (MODEL_TO_BILLING[packageModel]) {
        billingType = MODEL_TO_BILLING[packageModel];
    } else {
        throw new Error(`PACKAGE_INVALID_MODEL: Modelo desconhecido: ${packageModel}`);
    }
    
    const sessionValue = appointment.sessionValue || packageData?.sessionValue || 0;
    
    // 🚨 VALIDAÇÃO: sessionValue deve ser válido
    if (!sessionValue || sessionValue <= 0) {
        throw new Error(`INVALID_SESSION_VALUE: Valor da sessão inválido: ${sessionValue}`);
    }

    console.log(`[CompleteSessionV2] Dados processados`, {
        billingType,
        sessionValue,
        hasPackage: !!packageId,
        willUpdatePackage: !!packageId
    });

    // 🚨 VALIDAÇÃO: Não permitir addToBalance em pacotes já pagos (prepaid, convenio, liminar)
    // 🎯 FONTE DA VERDADE: package.model
    const isPaidPackage = ['prepaid', 'convenio', 'liminar'].includes(packageData?.model) || 
                          ['convenio', 'liminar'].includes(packageData?.type) ||
                          // ⚠️ FALLBACK: pacotes antigos sem model
                          (packageData?.paymentType === 'full' && !packageData?.model);
    
    console.log(`[CompleteSessionV2] Validação addToBalance:`, { billingType, addToBalance, isPaidPackage });
    
    if (isPaidPackage && addToBalance) {
        const typeLabel = billingType === 'prepaid' ? 'pré-pago' : 
                         billingType === 'convenio' ? 'convênio' : 
                         billingType === 'liminar' ? 'liminar' : 'já pago';
        throw new Error(`SESSION_ALREADY_PAID: Esta sessão faz parte de um pacote ${typeLabel} e não pode gerar saldo devedor`);
    }

    // ============================================================
    // FASE 2: TRANSAÇÃO DE MUTAÇÃO
    // ============================================================
    const mongoSession = externalSession || await mongoose.startSession();
    
    // 🎯 Variável para compartilhar estado entre Session e Appointment
    let sessionUpdate = null;
    
    try {
        if (!externalSession) {
            await mongoSession.startTransaction();
        }

        // 1. Verificar e atualizar Session (se existir)
        if (sessionId) {
            const session = await Session.findById(sessionId).session(mongoSession);
            if (!session) {
                throw new Error('SESSION_NOT_FOUND: Sessão não encontrada');
            }
            const isCancelledStatus = (status) => 
                status && ['canceled', 'cancelled', 'cancelado', 'processing_cancel'].includes(status.toLowerCase());
            
            if (isCancelledStatus(session.status)) {
                throw new Error('SESSION_CANCELLED: Esta sessão foi cancelada e não pode ser completada');
            }
            
            // 🎯 Atualiza Session com dados de pagamento baseado no tipo
            sessionUpdate = {
                status: 'completed',
                completedAt: new Date(),
                notes: notes || undefined,
                evolution: evolution || undefined,
                correlationId
            };
            
            // 💰 REGRA UNIFICADA: isPaid = !addToBalance (para todos os tipos)
            const paidNow = !addToBalance;
            
            if (billingType === 'liminar') {
                // ⚖️ Liminar: sempre pago (crédito judicial)
                sessionUpdate.isPaid = true;
                sessionUpdate.paymentStatus = 'paid';
                sessionUpdate.paymentOrigin = 'liminar_credit';
            } else if (billingType === 'prepaid') {
                // 💳 Pré-pago: já foi pago no pacote
                sessionUpdate.isPaid = true;
                sessionUpdate.paymentStatus = 'package_paid';
                sessionUpdate.paymentOrigin = 'package_prepaid';
            } else if (billingType === 'convenio') {
                // 🏥 Convênio: pago pelo convênio (não gera dívida)
                sessionUpdate.isPaid = true;
                sessionUpdate.paymentStatus = 'paid';
                sessionUpdate.paymentOrigin = 'convenio';
            } else {
                // 💰 Per-session: depende se pagou no ato ou ficou fiado (tudo unpaid se não pago)
                sessionUpdate.isPaid = paidNow;
                sessionUpdate.paymentStatus = paidNow ? 'paid' : 'unpaid';
                sessionUpdate.paymentOrigin = paidNow ? 'cash' : 'balance';
            }
            
            await Session.findByIdAndUpdate(
                sessionId,
                { $set: sessionUpdate },
                { session: mongoSession }
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
            packageUpdateResult = await updatePackageOnComplete(
                packageId,
                sessionValue,
                billingType,
                mongoSession
            );
            console.log(`[CompleteSessionV2] Package ${packageId} atualizado`, packageUpdateResult);
        }

        // 3. Atualizar Appointment (usando Session como fonte da verdade)
        const appointmentUpdate = {
            $set: {
                operationalStatus: 'completed',  // 🎯 CRM: fonte da verdade
                completedAt: new Date(),
                updatedAt: new Date(),
                completionNotes: notes,
                evolution: evolution,
                correlationId
            }
        };

        // 🎯 Fonte da verdade: Session define o pagamento, Appointment espelha
        if (sessionId && sessionUpdate) {
            appointmentUpdate.$set.isPaid = sessionUpdate.isPaid ?? false;
            appointmentUpdate.$set.paymentStatus = sessionUpdate.paymentStatus ?? 'unknown';
            appointmentUpdate.$set.paymentMethod = sessionUpdate.paymentOrigin ?? 'unknown';
            appointmentUpdate.$set.balanceAmount = (sessionUpdate.isPaid) ? 0 : (sessionValue || 0);
            
            console.log(`[CompleteSessionV2] Appointment espelhando Session:`, {
                isPaid: appointmentUpdate.$set.isPaid,
                paymentStatus: appointmentUpdate.$set.paymentStatus,
                paymentMethod: appointmentUpdate.$set.paymentMethod
            });
        } else if (!sessionId) {
            // 🔄 Fallback: sem session, inferir do billingType
            const isPaid = ['prepaid', 'liminar'].includes(billingType);
            appointmentUpdate.$set.isPaid = isPaid;
            appointmentUpdate.$set.paymentStatus = isPaid ? 'paid' : 'unpaid';
            appointmentUpdate.$set.paymentMethod = billingType === 'liminar' ? 'liminar_credit' : 
                                                   billingType === 'prepaid' ? 'package_prepaid' : 'cash';
            appointmentUpdate.$set.balanceAmount = isPaid ? 0 : (sessionValue || 0);
            
            console.log(`[CompleteSessionV2] Fallback (sem session):`, {
                isPaid,
                paymentStatus: appointmentUpdate.$set.paymentStatus,
                billingType
            });
        }

        await Appointment.updateOne(
            { _id: appointmentId },
            appointmentUpdate,
            { session: mongoSession }
        );

        if (!externalSession) {
            await mongoSession.commitTransaction();
        }

        console.log(`[CompleteSessionV2] ✅ Transação commitada (${Date.now() - startTime}ms)`);

        // 🔄 REBUILD SÍNCRONO da view (frontend precisa ver dados atualizados)
        let viewRebuilt = false;
        if (packageId) {
            try {
                const { buildPackageView } = await import('../../domains/billing/services/PackageProjectionService.js');
                await buildPackageView(packageId, { correlationId });
                console.log(`[CompleteSessionV2] 🔄 View do pacote ${packageId} reconstruída`);
                viewRebuilt = true;
            } catch (viewErr) {
                console.error(`[CompleteSessionV2] ⚠️ Erro ao reconstruir view:`, viewErr.message);
                // Não falha a operação, mas loga o erro
            }
        }

        // 💰 CRIAR PAYMENT se foi pago no ato (particular sem addToBalance)
        let paymentCreated = null;
        if (billingType === 'particular' && !addToBalance && sessionValue > 0) {
            try {
                paymentCreated = await Payment.create({
                    patient: appointment.patient?._id,
                    amount: sessionValue,
                    status: 'paid',
                    type: 'service',
                    serviceType: 'session',
                    paymentMethod: 'cash',
                    financialDate: new Date(), // 🎯 ESSENCIAL pro caixa
                    description: `Sessão realizada - ${appointment.patient?.fullName || 'Paciente'}`,
                    appointment: appointmentId,
                    createdBy: userId
                });
                console.log(`[CompleteSessionV2] 💰 Payment criado: ${paymentCreated._id}`);
            } catch (paymentErr) {
                console.error(`[CompleteSessionV2] ❌ Erro ao criar Payment:`, paymentErr.message);
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
        if (!externalSession) {
            await mongoSession.abortTransaction();
        }
        console.error(`[CompleteSessionV2] ❌ Erro:`, error.message);
        throw error;
    } finally {
        if (!externalSession) {
            mongoSession.endSession();
        }
    }
}

/**
 * Atualiza package na completação de sessão
 * 
 * Regras:
 * - sessionsDone++
 * - sessionsRemaining-- 
 * - balance: depende do tipo (particular += value, outros: sem mudança imediata)
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
            console.warn(`[CompleteSessionV2] Billing type não tratado: ${billingType}`);
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
    const totalSessions = packageDoc.totalSessions || 0;
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
 * Determina o tipo de billing baseado no appointment/package
 */
function determineBillingType(appointment, packageData) {
    // Prioridade 1: billingType do appointment
    if (appointment.billingType) {
        return appointment.billingType;
    }
    
    // Prioridade 2: model do package (V2 - campo semântico correto)
    if (packageData?.model) {
        if (packageData.model === 'convenio') return 'convenio';
        if (packageData.model === 'liminar') return 'liminar';
        if (packageData.model === 'prepaid') return 'prepaid';
        if (packageData.model === 'per_session') return 'particular';
    }
    
    // Prioridade 3: type do package (legado)
    if (packageData) {
        if (packageData.type === 'convenio') return 'convenio';
        if (packageData.type === 'liminar') return 'liminar';
        // ⚠️ FALLBACK: inferir de paymentType (pacotes antigos sem model)
        if (packageData.paymentType === 'per-session') return 'particular';
        if (packageData.paymentType === 'full') return 'prepaid';
        return packageData.type || 'particular';
    }
    
    // Default
    return 'particular';
}

export default { completeSessionV2 };
