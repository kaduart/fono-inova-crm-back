// domain/payment/cancelPendingPayments.js
import Payment from '../../models/Payment.js';

/**
 * Cancela payments pendentes que casam com o filtro (marca status='canceled').
 * Filtro é responsabilidade do chamador.
 *
 * ⚠️ Débito técnico conhecido (não corrigido aqui de propósito — backlog "PR5 Payment
 * Lifecycle Compliance"): DOMAIN_INVARIANTS.md manda nunca alterar Payment.status
 * direto no Mongo, sempre via paymentStatusService.transitionPaymentStatus() (emite
 * PAYMENT_STATUS_CHANGED, audit trail, campos derivados). Este helper só extrai o
 * updateMany em lote que já existia nas rotas de Package/InsuranceGuide — não migra
 * para transitionPaymentStatus porque essa função opera 1 payment por vez, e trocar
 * para loop aqui mudaria volume de eventos/performance/idempotência, o que é escopo
 * de outro PR, não de uma extração pura.
 *
 * @param {Object} filter - filtro Mongo completo
 */
export async function cancelPendingPayments(filter) {
    return Payment.updateMany(
        filter,
        { status: 'canceled', updatedAt: new Date(), _fromWriteGateway: true }
    );
}
