/**
 * Resolve visualFlag do Appointment a partir do estado financeiro da Session.
 * UI e cashflow usam visualFlag como atalho visual; manter sincronizado evita
 * que sessoes pagas aparecam como pendentes/debito.
 *
 * Regras:
 * - addToBalance/fiado -> 'pending'
 * - pago (paid, package_paid) -> 'ok'
 * - parcial -> 'partial'
 * - pendente/receber (pending_receipt, unpaid, etc) -> 'pending'
 */
export function resolveVisualFlag(sessionUpdate, isBalanceOrigin) {
    if (isBalanceOrigin) return 'pending';
    if (['paid', 'package_paid'].includes(sessionUpdate?.paymentStatus)) return 'ok';
    if (sessionUpdate?.paymentStatus === 'partial') return 'partial';
    return 'pending';
}

export default resolveVisualFlag;
