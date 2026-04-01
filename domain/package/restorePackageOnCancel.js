// domain/package/restorePackageOnCancel.js
import Package from '../../models/Package.js';
import Session from '../../models/Session.js';

/**
 * Restaura pacote quando agendamento é cancelado
 * 
 * REGRAS CRÍTICAS DO LEGADO:
 * - Se o agendamento estava 'completed', decrementa sessionsDone
 * - Se era per-session, estorna totalPaid e paidSessions
 * - NUNCA deixa sessionsDone < 0
 * - Recalcula balance e financialStatus automaticamente (via pre-save)
 * 
 * @param {ObjectId} packageId - ID do pacote
 * @param {Object} options - Opções
 * @param {String} options.appointmentStatus - Status do agendamento (completed, confirmed, etc)
 * @param {String} options.paymentOrigin - Origem do pagamento (auto_per_session, package_prepaid, etc)
 * @param {Number} options.sessionValue - Valor da sessão (para per-session)
 * @param {mongoose.ClientSession} options.mongoSession - Sessão MongoDB
 * @returns {Object} Resultado
 */
export async function restorePackageOnCancel(packageId, options = {}) {
    const { 
        appointmentStatus,
        paymentOrigin,
        sessionValue = 0,
        mongoSession = null,
        appointmentId = null,
        alreadyCanceled = false  // 🛡️ IDEMPOTÊNCIA: já foi cancelado?
    } = options;

    // 🛡️ GUARD 1: Se já foi cancelado, não restaura nada
    if (alreadyCanceled) {
        console.log(`[restorePackageOnCancel] Agendamento já cancelado, ignorando`);
        return {
            restored: false,
            reason: 'ALREADY_CANCELED',
            message: 'Agendamento já estava cancelado, nada a restaurar'
        };
    }

    const pkg = await Package.findById(packageId);
    
    if (!pkg) {
        throw new Error('PACKAGE_NOT_FOUND');
    }

    // 🛡️ GUARD 2: Só restaura se estava completed
    if (appointmentStatus !== 'completed') {
        return {
            restored: false,
            reason: 'APPOINTMENT_NOT_COMPLETED',
            message: 'Agendamento não estava completed, nada a restaurar'
        };
    }

    const updateOptions = mongoSession ? { session: mongoSession } : {};
    
    // Prepara o update dinamicamente
    const update = {
        $set: { updatedAt: new Date() }
    };

    // 1. Decrementa sessionsDone (sempre, pois foi incrementado no complete)
    if (pkg.sessionsDone > 0) {
        update.$inc = { ...update.$inc, sessionsDone: -1 };
    }

    // 2. Se era per-session, estorna financeiro
    const isPerSession = paymentOrigin === 'auto_per_session';
    
    if (isPerSession && sessionValue > 0) {
        const amountToRefund = Math.min(sessionValue, pkg.totalPaid || 0);
        
        if (amountToRefund > 0) {
            update.$inc = { 
                ...update.$inc, 
                totalPaid: -amountToRefund,
                paidSessions: -1 
            };
            
            console.log(`[restorePackageOnCancel] Estornando per-session`, {
                packageId,
                amountRefunded: amountToRefund,
                sessionValue,
                currentTotalPaid: pkg.totalPaid
            });
        }
    }

    // Executa update
    const result = await Package.findOneAndUpdate(
        { 
            _id: packageId,
            sessionsDone: { $gt: 0 } // Guard: só se tiver algo para decrementar
        },
        update,
        { ...updateOptions, new: true }
    );

    if (!result) {
        console.warn(`[restorePackageOnCancel] Pacote ${packageId} não encontrado ou sessionsDone já é 0`);
        return {
            restored: false,
            reason: 'NO_SESSIONS_TO_RESTORE'
        };
    }

    // O pre('save') vai recalcular balance e financialStatus automaticamente
    // Mas como usamos findOneAndUpdate, precisamos salvar explicitamente para triggerar o hook
    // OU calcular manualmente (vamos calcular manualmente para consistência)
    
    const newBalance = Math.max(0, result.totalValue - (result.totalPaid || 0));
    let newFinancialStatus = 'unpaid';
    if (result.totalPaid === 0) {
        newFinancialStatus = 'unpaid';
    } else if (result.totalPaid < result.totalValue) {
        newFinancialStatus = 'partially_paid';
    } else {
        newFinancialStatus = 'paid';
    }

    // Atualiza balance e financialStatus
    const finalResult = await Package.findByIdAndUpdate(
        packageId,
        {
            $set: {
                balance: newBalance,
                financialStatus: newFinancialStatus
            }
        },
        { ...updateOptions, new: true }
    );

    // 🛡️ CONSISTÊNCIA FINAL: Garante que balance está correto
    // Protege contra rounding errors ou race conditions
    const expectedBalance = Math.max(0, finalResult.totalValue - (finalResult.totalPaid || 0));
    if (finalResult.balance !== expectedBalance) {
        console.warn(`[restorePackageOnCancel] Inconsistência detectada no balance, corrigindo`, {
            packageId,
            currentBalance: finalResult.balance,
            expectedBalance
        });
        
        // Força correção
        await Package.findByIdAndUpdate(
            packageId,
            { $set: { balance: expectedBalance } },
            { ...updateOptions }
        );
        finalResult.balance = expectedBalance;
    }

    console.log(`[restorePackageOnCancel] Pacote ${packageId} restaurado`, {
        sessionsDone: finalResult.sessionsDone,
        totalPaid: finalResult.totalPaid,
        balance: finalResult.balance,
        financialStatus: finalResult.financialStatus,
        wasPerSession: isPerSession,
        amountRefunded: isPerSession ? sessionValue : 0
    });

    return {
        restored: true,
        package: finalResult,
        sessionsRestored: 1,
        amountRefunded: isPerSession ? sessionValue : 0,
        newBalance: finalResult.balance,
        financialStatus: finalResult.financialStatus
    };
}

/**
 * Verifica se uma sessão cancelada pode ser reaproveitada
 * 
 * @param {ObjectId} packageId - ID do pacote
 * @returns {Object|null} Dados do crédito ou null
 */
export async function checkReusableCredit(packageId) {
    const session = await Session.findOne({
        package: packageId,
        status: 'canceled',
        $or: [
            { originalPartialAmount: { $gt: 0 } },
            { originalIsPaid: true }
        ]
    }).sort({ canceledAt: -1 });

    if (!session) {
        return null;
    }

    return {
        available: true,
        sessionId: session._id,
        amount: session.originalPartialAmount || 0,
        paymentMethod: session.originalPaymentMethod
    };
}
