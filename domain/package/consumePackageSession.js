// domain/package/consumePackageSession.js
import Package from '../../models/Package.js';
import Session from '../../models/Session.js';

/**
 * Consome sessão do pacote (sessionsDone++)
 * 
 * REGRA CRÍTICA DO LEGADO:
 * - SÓ incrementa sessionsDone se ainda não estiver completado
 * - NÃO decrementa no cancelamento
 * - Usa $expr para evitar ultrapassar totalSessions
 * 
 * @param {ObjectId} packageId - ID do pacote
 * @param {Object} options - Opções
 * @param {mongoose.ClientSession} options.mongoSession - Sessão MongoDB
 * @returns {Object} Resultado
 */
export async function consumePackageSession(packageId, options = {}) {
    const { mongoSession = null } = options;

    console.log(`[consumePackageSession] Buscando package ${packageId}...`);
    const pkg = await Package.findById(packageId);
    console.log(`[consumePackageSession] Package ${packageId}: ${pkg ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}`);
    
    if (!pkg) {
        throw new Error('PACKAGE_NOT_FOUND');
    }

    const remaining = pkg.totalSessions - (pkg.sessionsDone || 0);

    if (remaining <= 0) {
        console.warn(`[consumePackageSession] Pacote ${packageId} sem crédito`);
        return {
            consumed: false,
            reason: 'NO_CREDIT',
            remainingSessions: 0,
            totalSessions: pkg.totalSessions,
            sessionsDone: pkg.sessionsDone
        };
    }

    // Incrementa sessionsDone
    const updateOptions = mongoSession ? { session: mongoSession } : {};
    
    const result = await Package.findOneAndUpdate(
        {
            _id: packageId,
            $expr: { $lt: ["$sessionsDone", "$totalSessions"] } // Guard: só se tiver crédito
        },
        {
            $inc: { sessionsDone: 1 },
            $set: { updatedAt: new Date() }
        },
        { ...updateOptions, new: true }
    );

    if (!result) {
        console.warn(`[consumePackageSession] Pacote ${packageId} sem crédito disponível`);
        return {
            consumed: false,
            reason: 'NO_CREDIT_AVAILABLE',
            remainingSessions: remaining
        };
    }

    console.log(`[consumePackageSession] Pacote ${packageId} consumido`, {
        sessionsDone: result.sessionsDone,
        totalSessions: result.totalSessions,
        remaining: result.totalSessions - result.sessionsDone
    });

    return {
        consumed: true,
        package: result,
        remainingSessions: result.totalSessions - result.sessionsDone
    };
}

/**
 * Cria sessão vinculada ao pacote
 * 
 * Regras do legado (appointment.js:338-361, syncService.js:150-170):
 * - Herda dados do pacote
 * - isPaid: true (usa crédito do pacote)
 * - paymentStatus: 'package_paid' ou 'paid'
 * - paymentOrigin: 'package_prepaid'
 * 
 * @param {Object} data - Dados da sessão
 * @returns {Object} Session criada
 */
export async function createPackageSession(data) {
    const {
        patientId,
        doctorId,
        packageId,
        appointmentId,
        date,
        time,
        specialty,
        sessionValue = 0,
        billingType = null,
        creditData = null, // Dados de reaproveitamento
        correlationId = null
    } = data;

    const pkg = await Package.findById(packageId);
    const effectiveBillingType = billingType || pkg?.type || 'particular';

    // Determina status de pagamento baseado no tipo de pacote / crédito
    let isPaid = creditData ? creditData.isPaid : true;
    let paymentStatus = creditData ? creditData.paymentStatus : 'package_paid';
    let visualFlag = creditData ? creditData.visualFlag : 'ok';
    let paymentMethod = creditData 
        ? creditData.paymentMethod 
        : (pkg?.paymentMethod || 'dinheiro');

    if (effectiveBillingType === 'convenio') {
        isPaid = false;
        paymentStatus = 'pending_receipt';
        visualFlag = 'pending';
        paymentMethod = 'convenio';
    } else if (effectiveBillingType === 'liminar') {
        isPaid = false;
        paymentStatus = 'pending';
        visualFlag = 'pending';
        paymentMethod = 'liminar_credit';
    }

    const partialAmount = creditData ? creditData.partialAmount : 0;

    const session = new Session({
        patient: patientId,
        doctor: doctorId,
        package: packageId,
        appointmentId: appointmentId,
        date,
        time,
        sessionType: specialty,
        specialty,
        sessionValue: creditData ? creditData.partialAmount || sessionValue : sessionValue,
        status: 'scheduled',
        isPaid,
        paymentStatus,
        paymentOrigin: creditData ? 'package_prepaid' : 'package_prepaid',
        visualFlag,
        paymentMethod,
        partialAmount,
        correlationId,
        notes: creditData 
            ? `Reaproveitamento de sessão cancelada: ${creditData.originalSessionId}` 
            : '',
        createdAt: new Date()
    });

    await session.save();

    console.log(`[createPackageSession] Sessão ${session._id} criada para pacote ${packageId}`, {
        isPaid,
        paymentStatus,
        reusedCredit: !!creditData,
        partialAmount
    });

    return session;
}

/**
 * Busca e reaproveita crédito de sessão cancelada
 * 
 * Regras do legado (appointment.js:289-336):
 * - Busca sessão cancelada com originalPartialAmount > 0 ou originalIsPaid
 * - Zera campos 'original*' da sessão antiga
 * - Retorna dados para nova sessão
 * 
 * @param {ObjectId} packageId - ID do pacote
 * @returns {Object|null} Dados do crédito ou null
 */
export async function findAndConsumeReusableCredit(packageId) {
    // Busca sessão cancelada com crédito
    const canceledSession = await Session.findOne({
        package: packageId,
        status: 'canceled',
        $or: [
            { originalPartialAmount: { $gt: 0 } },
            { originalIsPaid: true }
        ]
    }).sort({ canceledAt: -1 });

    if (!canceledSession) {
        return null;
    }

    console.log(`[findAndConsumeReusableCredit] Crédito encontrado: ${canceledSession._id}`, {
        originalPartialAmount: canceledSession.originalPartialAmount,
        originalIsPaid: canceledSession.originalIsPaid
    });

    // Extrai dados do crédito
    const creditData = {
        isPaid: true,
        paymentStatus: 'paid',
        visualFlag: 'ok',
        partialAmount: Number(canceledSession.originalPartialAmount) || 0,
        paymentMethod: canceledSession.originalPaymentMethod || 'dinheiro',
        originalSessionId: canceledSession._id.toString()
    };

    // 🔒 ZERA para evitar reuso duplo (CRÍTICO!)
    await Session.findByIdAndUpdate(canceledSession._id, {
        $set: {
            originalPartialAmount: 0,
            originalPaymentStatus: null,
            originalIsPaid: false,
            originalPaymentMethod: null
        }
    });

    console.log(`[findAndConsumeReusableCredit] Crédito consumido e zerado`);

    return creditData;
}

/**
 * Atualiza estado financeiro do pacote (per-session)
 * 
 * REGRAS DO LEGADO (appointment.js:1846-1858):
 * - Incrementa totalPaid
 * - Incrementa paidSessions
 * - Recalcula balance (via pre-save)
 * - Atualiza financialStatus (via pre-save)
 * 
 * NOTA: Não calculamos balance/financialStatus aqui porque o pre('save') 
 * do Package faz isso automaticamente. Mas como usamos findOneAndUpdate,
 * precisamos calcular manualmente ou chamar save() depois.
 * 
 * @param {ObjectId} packageId - ID do pacote
 * @param {Number} amount - Valor pago
 * @returns {Object} Resultado
 */
export async function updatePackageFinancials(packageId, amount, mongoSession = null, existingPackage = null) {
    // NOTA: Se package já foi carregado, usa ele; senão busca no DB
    let pkg = existingPackage;
    if (!pkg) {
        console.log(`[updatePackageFinancials] Buscando package ${packageId}...`);
        pkg = await Package.findById(packageId);
    } else {
        console.log(`[updatePackageFinancials] Usando package já carregado: ${pkg._id}`);
    }
    
    if (!pkg) {
        console.error(`[updatePackageFinancials] Package ${packageId} NÃO ENCONTRADO!`);
        throw new Error('PACKAGE_NOT_FOUND');
    }

    const currentTotalPaid = pkg.totalPaid || 0;
    const newTotalPaid = currentTotalPaid + amount;
    const totalValue = pkg.totalValue || 0;

    // Calcula balance e financialStatus (pre-save não roda em findOneAndUpdate)
    const newBalance = Math.max(0, totalValue - newTotalPaid);
    let financialStatus = 'unpaid';
    if (newTotalPaid >= totalValue) {
        financialStatus = 'paid';
    } else if (newTotalPaid > 0) {
        financialStatus = 'partially_paid';
    }

    // Só usa sessão se fornecida (evita problemas com transações)
    const updateOptions = { new: true };
    if (mongoSession) {
        updateOptions.session = mongoSession;
    }
    
    const result = await Package.findByIdAndUpdate(
        packageId,
        {
            $inc: { 
                totalPaid: amount,
                paidSessions: 1
            },
            $set: {
                balance: newBalance,
                financialStatus,
                lastPaymentAt: new Date(),
                updatedAt: new Date()
            }
        },
        updateOptions
    );

    console.log(`[updatePackageFinancials] Pacote ${packageId} atualizado`, {
        totalPaid: result.totalPaid,
        paidSessions: result.paidSessions,
        balance: result.balance,
        financialStatus: result.financialStatus
    });

    return result;
}
