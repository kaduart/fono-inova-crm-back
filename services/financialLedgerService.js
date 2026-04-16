/**
 * 🏦 FINANCIAL LEDGER SERVICE
 * 
 * Responsabilidade: Registrar TODAS as movimentações financeiras no Ledger.
 * 
 * Regra: Todo movimento de dinheiro GERA um lançamento contábil.
 * Nunca alterar - só lançar.
 */

import FinancialLedger from '../models/FinancialLedger.js';
import { resolveSessionBillingType } from '../utils/billingHelpers.js';

/**
 * Registra reconhecimento de receita de uma sessão avulsa (particular, convênio ou liminar)
 */
export async function recordSessionRevenue(session, options = {}, mongoSession) {
    const { userId, userName, correlationId } = options;
    
    const billingType = resolveSessionBillingType(session);
    const amount = session.package?.insuranceGrossAmount || session.sessionValue || 0;
    
    return FinancialLedger.credit({
        type: 'revenue_recognition',
        amount,
        billingType,
        patient: session.patient,
        appointment: session.appointmentId,
        session: session._id,
        correlationId: correlationId || session.correlationId || `session_${session._id}`,
        description: `Receita reconhecida - ${billingType}`,
        occurredAt: session.revenueRecognizedAt || session.completedAt || session.updatedAt || new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'session_complete',
            paymentMethod: session.paymentMethod,
            sessionType: session.sessionType,
            insuranceGuide: session.insuranceGuide
        }
    }, mongoSession);
}

/**
 * Registra um pagamento recebido
 */
export async function recordPaymentReceived(payment, options = {}, mongoSession) {
    const { userId, userName, ip, userAgent, correlationId } = options;
    
    return FinancialLedger.credit({
        type: 'payment_received',
        amount: payment.amount,
        patient: payment.patient,
        appointment: payment.appointment,
        session: payment.session,
        payment: payment._id,
        correlationId: correlationId || payment.correlationId,
        description: `Pagamento recebido - ${payment.paymentMethod}`,
        occurredAt: payment.paidAt || payment.paymentDate,
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'payment_confirmation',
            paymentMethod: payment.paymentMethod,
            ip,
            userAgent
        }
    }, mongoSession);
}

/**
 * Registra um pagamento pendente (fiado)
 */
export async function recordPaymentPending(payment, options = {}, mongoSession) {
    const { userId, userName, correlationId } = options;
    
    // Quando é fiado, registramos como "a receber" (crédito a receber)
    // Na contabilidade, isso é uma conta a receber (ativo)
    return FinancialLedger.credit({
        type: 'payment_pending',
        amount: payment.amount,
        patient: payment.patient,
        appointment: payment.appointment,
        payment: payment._id,
        correlationId: correlationId || payment.correlationId,
        description: 'Pagamento pendente - adicionado ao saldo devedor',
        occurredAt: new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'balance_add',
            expectedPaymentDate: null
        }
    }, mongoSession);
}

/**
 * Registra uma sessão de pacote consumida
 */
export async function recordPackageSessionConsumed(session, pkg, options = {}, mongoSession) {
    const { userId, userName, correlationId } = options;
    
    // Quando consome uma sessão de pacote, reconhecemos a receita
    return FinancialLedger.credit({
        type: 'package_consumed',
        amount: pkg.sessionValue || 0,
        patient: session.patient,
        appointment: session.appointment,
        session: session._id,
        package: pkg._id,
        correlationId: correlationId || session.correlationId,
        description: `Sessão de pacote consumida - ${pkg.name || 'Pacote'}`,
        occurredAt: session.completedAt || new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'session_complete',
            packageType: pkg.type,
            sessionNumber: pkg.sessionsDone
        }
    }, mongoSession);
}

/**
 * Registra um estorno (refund)
 */
export async function recordRefund(payment, refundAmount, options = {}, mongoSession) {
    const { userId, userName, reason, correlationId } = options;
    
    return FinancialLedger.debit({
        type: 'refund',
        amount: refundAmount,
        patient: payment.patient,
        appointment: payment.appointment,
        payment: payment._id,
        correlationId: correlationId || `refund_${Date.now()}`,
        description: `Estorno - ${reason || 'Sem motivo informado'}`,
        occurredAt: new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'refund',
            originalAmount: payment.amount,
            refundAmount,
            reason
        }
    }, mongoSession);
}

/**
 * Registra faturamento de convênio (conta a receber)
 */
export async function recordInsuranceBilled(payment, options = {}, mongoSession) {
    const { userId, userName, correlationId, billedAt } = options;
    
    return FinancialLedger.credit({
        type: 'insurance_billed',
        amount: payment.insurance?.grossAmount || payment.amount || 0,
        billingType: 'convenio',
        patient: payment.patient,
        appointment: payment.appointment,
        session: payment.session,
        payment: payment._id,
        correlationId: correlationId || payment.correlationId || `insurance_billed_${payment._id}`,
        description: `Convênio faturado - ${payment.insurance?.provider || 'Convênio'}`,
        occurredAt: billedAt || payment.insurance?.billedAt || new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'insurance_billing',
            provider: payment.insurance?.provider,
            authorizationCode: payment.insurance?.authorizationCode
        }
    }, mongoSession);
}

/**
 * Registra recebimento de convênio (entrada de caixa)
 */
export async function recordInsuranceReceived(payment, options = {}, mongoSession) {
    const { userId, userName, correlationId, receivedAt } = options;
    
    return FinancialLedger.credit({
        type: 'insurance_received',
        amount: payment.insurance?.receivedAmount || payment.amount || 0,
        billingType: 'convenio',
        patient: payment.patient,
        appointment: payment.appointment,
        session: payment.session,
        payment: payment._id,
        correlationId: correlationId || payment.correlationId || `insurance_received_${payment._id}`,
        description: `Convênio recebido - ${payment.insurance?.provider || 'Convênio'}`,
        occurredAt: receivedAt || payment.insurance?.receivedAt || new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'insurance_return',
            provider: payment.insurance?.provider,
            grossAmount: payment.insurance?.grossAmount,
            receivedAmount: payment.insurance?.receivedAmount,
            glosaAmount: payment.insurance?.glosaAmount || 0
        }
    }, mongoSession);
}

/**
 * Registra compra de pacote
 */
export async function recordPackagePurchase(pkg, payment, options = {}, mongoSession) {
    const { userId, userName, correlationId } = options;
    
    return FinancialLedger.credit({
        type: 'package_purchase',
        amount: pkg.totalValue || pkg.amount || 0,
        patient: pkg.patient,
        package: pkg._id,
        payment: payment?._id,
        correlationId: correlationId || pkg.correlationId,
        description: `Compra de pacote - ${pkg.name || 'Pacote'} (${pkg.totalSessions} sessões)`,
        occurredAt: pkg.purchasedAt || pkg.createdAt || new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'package_purchase',
            totalSessions: pkg.totalSessions,
            sessionValue: pkg.sessionValue
        }
    }, mongoSession);
}

/**
 * Registra um ajuste manual
 */
export async function recordAdjustment(data, options = {}, mongoSession) {
    const { originalAmount, newAmount, patient, appointment, reason, userId, userName, correlationId } = data;
    
    return FinancialLedger.adjustment({
        originalAmount,
        newAmount,
        patient,
        appointment,
        correlationId: correlationId || `adjust_${Date.now()}`,
        description: `Ajuste manual - ${reason}`,
        occurredAt: new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'manual_adjustment',
            reason,
            previousValue: originalAmount,
            newValue: newAmount
        }
    }, mongoSession);
}

/**
 * Registra reversão de receita por cancelamento de sessão
 */
export async function recordSessionCancellationReversal(session, options = {}, mongoSession) {
    const { userId, userName, correlationId, reason } = options;
    
    const billingType = resolveSessionBillingType(session);
    const amount = session.package?.insuranceGrossAmount || session.sessionValue || 0;
    
    return FinancialLedger.debit({
        type: 'reversal',
        amount,
        billingType,
        patient: session.patient,
        appointment: session.appointmentId,
        session: session._id,
        correlationId: correlationId || `cancel_${session._id}_${Date.now()}`,
        description: `Reversão de receita - sessão cancelada: ${reason || 'Sem motivo'}`,
        occurredAt: new Date(),
        createdBy: userId,
        createdByName: userName,
        metadata: {
            source: 'session_cancel',
            paymentMethod: session.paymentMethod,
            sessionType: session.sessionType,
            insuranceGuide: session.insuranceGuide,
            originalPaymentStatus: session.paymentStatus,
            originalPaymentOrigin: session.paymentOrigin,
            reason
        }
    }, mongoSession);
}

/**
 * Reconciliação automática
 * Verifica se o total do Ledger bate com o total de Payments
 */
export async function reconcileLedger(filters = {}) {
    const ledgerTotals = await FinancialLedger.reconcile(filters);
    
    console.log('[LedgerService] Reconciliação:', {
        credit: ledgerTotals.credit,
        debit: ledgerTotals.debit,
        balance: ledgerTotals.balance,
        filters
    });
    
    return ledgerTotals;
}

/**
 * Gera relatório de cashflow
 */
export async function generateCashflowReport(startDate, endDate, groupBy = 'day') {
    const matchStage = {
        occurredAt: { $gte: startDate, $lte: endDate }
    };
    
    const groupStage = {
        $group: {
            _id: {
                period: groupBy === 'day' 
                    ? { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } }
                    : groupBy === 'month'
                        ? { $dateToString: { format: '%Y-%m', date: '$occurredAt' } }
                        : { $dateToString: { format: '%Y-%W', date: '$occurredAt' } },
                direction: '$direction'
            },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
            entries: { $push: '$$ROOT' }
        }
    };
    
    const results = await FinancialLedger.aggregate([
        { $match: matchStage },
        groupStage,
        { $sort: { '_id.period': 1 } }
    ]);
    
    // Formata para fácil consumo
    const formatted = {};
    results.forEach(r => {
        const period = r._id.period;
        if (!formatted[period]) {
            formatted[period] = { credit: 0, debit: 0, balance: 0, count: 0 };
        }
        formatted[period][r._id.direction] = r.total;
        formatted[period].count += r.count;
    });
    
    // Calcula saldo
    Object.keys(formatted).forEach(period => {
        formatted[period].balance = formatted[period].credit - formatted[period].debit;
    });
    
    return {
        startDate,
        endDate,
        groupBy,
        periods: formatted,
        totals: await FinancialLedger.reconcile(matchStage)
    };
}

export default {
    recordSessionRevenue,
    recordPaymentReceived,
    recordPaymentPending,
    recordPackageSessionConsumed,
    recordInsuranceBilled,
    recordInsuranceReceived,
    recordRefund,
    recordPackagePurchase,
    recordAdjustment,
    reconcileLedger,
    generateCashflowReport
};
