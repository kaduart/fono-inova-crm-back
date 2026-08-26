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
 *
 * 🛡️ Idempotência por CICLO DE LIQUIDAÇÃO, atômica no banco (não check-then-act):
 *
 * Um Payment pode ser pago, revertido (paid→pending/canceled) e pago de novo
 * — cada vez que isso acontece é um CICLO distinto, e cada ciclo tem direito
 * a exatamente um crédito líquido. Um `exists()` antes do insert (fix
 * anterior, 2026-08-26) tem uma janela de corrida real: duas chamadas
 * concorrentes (ex: routes/payment.v2.js create-sync +
 * completeSessionService.v2.js, achado real em produção) podem AMBAS passar
 * pelo `exists()` antes de qualquer uma commitar — reproduzido em
 * tests/unit/financialLedgerService.raceCondition.repro.test.js.
 *
 * Correção: a chave de idempotência é o **índice do ciclo**, contado pelo
 * número de REVERSÕES já lançadas pra este Payment — NÃO pelo número de
 * créditos. Um ciclo novo só é legítimo depois de uma reversão de verdade
 * (paid→não-paid); contar créditos direto geraria um cycle-N diferente pra
 * toda chamada nova, mesmo sem reversão nenhuma no meio, e não pegaria a
 * duplicidade sequencial (não concorrente) do achado real: create-sync
 * credita (cycle-0), a MESMA sessão é concluída minutos depois via
 * completeSessionService.v2.js sem NENHUMA reversão ter acontecido — com
 * contagem por crédito isso vira cycle-1 (diferente, não colide); com
 * contagem por reversão continua cycle-0 (mesmo id, colide corretamente).
 * Reproduzido em
 * tests/integration/paymentLedgerDuplication.routes.integration.test.js
 * (passando pelas duas rotas/call sites reais, não por chamada direta).
 *
 * `correlationId` gravado é determinístico
 * (`payment_received:<paymentId>:cycle-<N>`), protegido pelo índice único
 * (correlationId, type) que JÁ EXISTIA no schema — a proteção passa a ser do
 * MongoDB no insert, não de uma leitura prévia. Duas chamadas concorrentes
 * pro mesmo ciclo calculam o MESMO N e colidem no índice; a que perde a
 * corrida recebe o erro de duplicidade (11000) e retorna a entrada que já foi
 * criada, sem propagar erro pro chamador.
 *
 * O correlationId original do chamador é preservado em
 * metadata.callerCorrelationId, só para rastreabilidade de qual código disparou.
 */
export async function recordPaymentReceived(payment, options = {}, mongoSession) {
    const { userId, userName, ip, userAgent, correlationId: callerCorrelationId } = options;

    const cycleQuery = FinancialLedger.countDocuments({ payment: payment._id, type: 'reversal' });
    if (mongoSession) cycleQuery.session(mongoSession);
    const cycleIndex = await cycleQuery;
    const cycleCorrelationId = `payment_received:${payment._id}:cycle-${cycleIndex}`;

    // 🛡️ Dentro de uma transação do CHAMADOR (ex: completeSessionV2 chama
    // isso com sua própria mongoSession), um erro de chave duplicada MARCA A
    // TRANSAÇÃO INTEIRA COMO ABORTADA no MongoDB — não dá pra "pegar o erro e
    // continuar consultando" como fora de uma transação (confirmado
    // empiricamente: tentar isso quebra com "Transaction ... has been
    // aborted", não com o 11000 original). Por isso, quando há mongoSession,
    // checamos ANTES de escrever, evitando disparar o erro dentro da
    // transação alheia. Fora de transação (chamada solta, sem mongoSession —
    // o caso real da corrida entre create-sync e completeSessionV2, que
    // rodam em transações SEPARADAS e sequenciais, não simultâneas dentro da
    // mesma), o catch abaixo continua sendo a proteção atômica de verdade.
    if (mongoSession) {
        const preCheckQuery = FinancialLedger.findOne({ correlationId: cycleCorrelationId, type: 'payment_received' }).session(mongoSession);
        const preExisting = await preCheckQuery.lean();
        if (preExisting) {
            console.warn(`[FinancialLedgerService] recordPaymentReceived: ciclo ${cycleIndex} do Payment ${payment._id} já creditado (${preExisting._id}) — pulando, sem duplicar.`);
            return preExisting;
        }
    }

    try {
        return await FinancialLedger.credit({
            type: 'payment_received',
            amount: payment.amount,
            patient: payment.patient,
            appointment: payment.appointment,
            session: payment.session,
            payment: payment._id,
            correlationId: cycleCorrelationId,
            description: `Pagamento recebido - ${payment.paymentMethod}`,
            occurredAt: payment.paidAt || payment.paymentDate,
            createdBy: userId,
            createdByName: userName,
            metadata: {
                source: 'payment_confirmation',
                paymentMethod: payment.paymentMethod,
                ip,
                userAgent,
                callerCorrelationId: callerCorrelationId || null,
                cycleIndex
            }
        }, mongoSession);
    } catch (err) {
        if (err?.code === 11000 && !mongoSession) {
            const existing = await FinancialLedger.findOne({ correlationId: cycleCorrelationId, type: 'payment_received' }).lean();
            if (existing) {
                console.warn(`[FinancialLedgerService] recordPaymentReceived: concorrência detectada no ciclo ${cycleIndex} do Payment ${payment._id} — outra chamada já creditou (${existing._id}). Retornando entrada existente, sem duplicar.`);
                return existing;
            }
        }
        throw err;
    }
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
    const { userId, userName, correlationId, receivedAt, receivedAmount } = options;
    
    return FinancialLedger.credit({
        type: 'insurance_received',
        amount: receivedAmount ?? payment.insurance?.receivedAmount ?? payment.amount ?? 0,
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
