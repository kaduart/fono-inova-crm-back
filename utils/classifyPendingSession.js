/**
 * Classifica uma sessão `completed` que ainda não tem pagamento vinculado.
 *
 * Regras oficiais:
 *   - package     → crédito de pacote pré-pago
 *   - insurance   → convênio a receber
 *   - liminar     → liminar a receber
 *   - privatePending → particular pendente (fiado)
 *   - realIssue   → inconsistência real (investigar)
 *
 * @param {Object} session
 * @returns {'package'|'insurance'|'liminar'|'privatePending'|'realIssue'}
 */
export function classifyPendingSession(session) {
  const method = (session.paymentMethod || '').toLowerCase();
  const origin = (session.paymentOrigin || '').toLowerCase();
  const status = (session.paymentStatus || '').toLowerCase();

  if (method === 'package_prepaid' || origin === 'package_prepaid' || status === 'package_paid' || session.package) {
    return 'package';
  }

  if (method === 'convenio' || origin === 'convenio' || status === 'pending_receipt' || session.insuranceGuide) {
    return 'insurance';
  }

  if (method === 'liminar_credit' || origin.includes('liminar')) {
    return 'liminar';
  }

  if (method === 'particular' || origin === 'particular' || status === 'pending_payment' || status === 'unpaid') {
    return 'privatePending';
  }

  return 'realIssue';
}

export function isSessionCovered(session) {
  return classifyPendingSession(session) !== 'realIssue';
}
