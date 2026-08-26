/**
 * Invariante canônica: o que é "consumo de pacote" num Payment.
 *
 * Existe porque três serviços diferentes precisavam da MESMA checagem
 * (isFromPackage/kind='package_consumed' nunca pode virar recebível de
 * convênio nem entrar em caixa) e cada um reimplementava o teste manualmente:
 * `services/billingSubmission/paymentBillingInvariants.js` (assertPaymentBillable,
 * V5/V6/S3), `services/insuranceBatchService.js` (createBatch/sendBatch) e
 * `services/paymentStatusService.js` (transitionPaymentStatus). Reimplementação
 * duplicada é exatamente como o path ativo em insuranceBatchService.js ficou
 * sem a guarda por tanto tempo — auditoria 2026-08-26, ver
 * scripts/maintenance/audit-convenio-isfrompackage-2026-08-26.mjs.
 *
 * Ver DOMAIN_INVARIANTS.md #10 e utils/packageFinancialModel.js (classificação
 * de Package nos quatro modelos financeiros — prepaid/per_session/liminar/
 * convenio). Este arquivo é o nível Payment: não decide o modelo do Package,
 * só se ESTE Payment específico representa consumo de crédito de pacote.
 */

export function isPackageConsumptionPayment(payment) {
  return !!(payment?.isFromPackage || payment?.kind === 'package_consumed');
}

export class PackageConsumptionInBillingError extends Error {
  /**
   * @param {Array<{_id?: any, paymentId?: string, isFromPackage?: boolean, kind?: string, session?: any}>} offendingPayments
   * @param {string} context — onde a violação foi detectada (ex.: 'createBatch', 'sendBatch', 'transitionPaymentStatus:billed')
   */
  constructor(offendingPayments, context) {
    const ids = offendingPayments.map(p => (p._id ?? p.paymentId)?.toString?.() ?? String(p._id ?? p.paymentId));
    super(
      `[FINANCIAL_LOCK] ${offendingPayments.length} Payment(s) de consumo de pacote (isFromPackage/kind='package_consumed') não pode(m) ser faturado(s)/recebido(s) como convênio (${context}): ${ids.join(', ')}`
    );
    this.name = 'PackageConsumptionInBillingError';
    this.code = 'PAYMENT_IS_PACKAGE_CONSUMPTION';
    this.context = context;
    this.offendingPaymentIds = ids;
  }
}

export default { isPackageConsumptionPayment, PackageConsumptionInBillingError };
